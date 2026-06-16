#!/usr/bin/env -S npx tsx

import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { parse } from "yaml";
import {
	AuthStorage,
	type AgentSessionEvent,
	createAgentSession,
	createExtensionRuntime,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "../src/index.ts";
import { inferVerifierAssets, preparePythonEnvironment } from "./memswe-smoke-runner-lib.ts";

const DEFAULT_TASK_ID = "repo-gamma-invoice-export-001";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const MEMSWE_ROOT = resolve(REPO_ROOT, "../memswe");
const RUNS_ROOT = join(REPO_ROOT, ".memswe-runs");

type VerifierKind = "visible" | "hidden" | "protected";

type TaskYaml = {
	schema_version?: string;
	harbor?: {
		metadata?: { task_id?: string };
		verifier?: { timeout_sec?: number };
		environment?: { setup_command?: string };
	};
	memswe?: {
		memory_conditions?: Array<{ id?: string; memory_system?: string }>;
		session_sequence?: SessionSpec[];
		verifiers?: {
			visible_tests?: VerifierSpec[];
			hidden_tests?: VerifierSpec[];
			protected_tests?: VerifierSpec[];
		};
		trace_predicates?: Array<{ id?: string; severity?: "blocking" | "diagnostic" }>;
	};
};

type SessionSpec = {
	session_id?: string;
	prompt_ref?: string;
	graded?: boolean;
};

type VerifierSpec = {
	id?: string;
	command?: string;
	agent_visible?: boolean;
	f2p?: boolean;
	p2p?: boolean;
};

type VerifierCommand = {
	id: string;
	kind: VerifierKind;
	command: string;
};

type CommandResult = VerifierCommand & {
	exit_code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	duration_ms: number;
};

type FauxAgentResult = {
	session_id: string;
	prompt_ref: string;
	final_response: string;
	event_count: number;
	message_count: number;
	status: "completed" | "errored";
	error: string | null;
};

type RunRecord = {
	run_id: string;
	task_id: string;
	schema_version: "uam-run.v0.1";
	condition: {
		condition_id: string;
		memory_system: string | null;
		baseline_kind: string | null;
		model_id: string;
		repetition_index: number;
		k: number;
	};
	session_results: Array<{
		session_id: string;
		status: "completed" | "errored" | "timeout" | "skipped";
		trace_id: string | null;
		artifact_paths: Record<string, string>;
	}>;
	reward: {
		reward: 0 | 1;
		f2p_total: number;
		f2p_passed: number;
		p2p_total: number;
		p2p_passed: number;
		f2p: number;
		p2p: number;
		partial: number;
		apply_failed: 0 | 1;
	};
	metric_vector: Record<string, number | null | number[] | Record<string, number>>;
	trace_predicate_results: Array<{
		id: string;
		outcome: "pass" | "fail" | "not_evaluable";
		severity: "blocking" | "diagnostic";
		evidence_ref: string | null;
	}>;
	primary_failure_category: "task_failure" | "process_failure" | null;
	output_locations: {
		trace_store_ref: string;
		postgres_run_ref: string | null;
		artifacts_dir: string;
	};
};

function getArgumentValue(name: string): string | undefined {
	const prefix = `${name}=`;
	const withEquals = process.argv.find((arg) => arg.startsWith(prefix));
	if (withEquals) return withEquals.slice(prefix.length);
	const index = process.argv.indexOf(name);
	if (index !== -1) return process.argv[index + 1];
	return undefined;
}

function hasFlag(name: string): boolean {
	return process.argv.includes(name);
}

function isTaskYaml(value: unknown): value is TaskYaml {
	return typeof value === "object" && value !== null;
}

function toJsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
		return undefined;
	}
	if (Array.isArray(value)) {
		return value.map((item) => toJsonSafe(item, seen));
	}
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: value.stack };
	}
	if (typeof value === "object") {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.map(([key, entry]) => [key, toJsonSafe(entry, seen)])
				.filter(([, entry]) => entry !== undefined),
		);
	}
	return String(value);
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object" || !("type" in part)) return "";
			const typed = part as { type?: unknown; text?: unknown; thinking?: unknown };
			if (typed.type === "text" && typeof typed.text === "string") return typed.text;
			if (typed.type === "thinking" && typeof typed.thinking === "string") return typed.thinking;
			return "";
		})
		.filter((part) => part.length > 0)
		.join("\n");
}

function resolveGradedSession(task: TaskYaml): SessionSpec {
	const sessions = task.memswe?.session_sequence ?? [];
	const graded = sessions.find((session) => session.graded);
	const fallback = sessions.at(-1);
	if (!graded && !fallback) throw new Error("Task has no session_sequence entries");
	const session = graded ?? fallback;
	if (!session?.session_id || !session.prompt_ref) {
		throw new Error("Graded session is missing session_id or prompt_ref");
	}
	return session;
}

function createMemSwerResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => `You are a deterministic MEMSWE smoke-test assistant.
Do not call tools. Do not edit files. Acknowledge the task prompt and stop.`,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

async function runFauxAgentSession(task: TaskYaml, taskDir: string, workdir: string, artifactsDir: string): Promise<FauxAgentResult> {
	const gradedSession = resolveGradedSession(task);
	const prompt = await readFile(join(taskDir, gradedSession.prompt_ref!), "utf8");
	const fauxProvider = registerFauxProvider();
	const model = fauxProvider.getModel();
	fauxProvider.setResponses([
		fauxAssistantMessage(
			`MEMSWE faux-agent smoke response for ${task.harbor?.metadata?.task_id ?? DEFAULT_TASK_ID} / ${gradedSession.session_id}.`,
		),
	]);

	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: fauxProvider.api,
		models: fauxProvider.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});

	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
	const events: AgentSessionEvent[] = [];
	const { session } = await createAgentSession({
		cwd: workdir,
		agentDir: join(artifactsDir, "agent-dir"),
		model,
		thinkingLevel: "off",
		authStorage,
		modelRegistry,
		resourceLoader: createMemSwerResourceLoader(),
		tools: [],
		sessionManager: SessionManager.inMemory(workdir),
		settingsManager,
	});

	let status: FauxAgentResult["status"] = "completed";
	let error: string | null = null;
	try {
		session.subscribe((event) => {
			events.push(event);
		});
		await session.prompt(prompt);
	} catch (caught) {
		status = "errored";
		error = caught instanceof Error ? caught.message : String(caught);
	} finally {
		await writeFile(join(artifactsDir, "agent-events.json"), `${JSON.stringify(toJsonSafe(events), null, "	")}\n`);
		await writeFile(join(artifactsDir, "agent-messages.json"), `${JSON.stringify(toJsonSafe(session.messages), null, "	")}\n`);
		session.dispose();
		fauxProvider.unregister();
	}

	const assistantMessages = session.messages.filter((message) => message.role === "assistant");
	const finalResponse = messageText(assistantMessages.at(-1));
	await writeFile(join(artifactsDir, "agent-final-response.txt"), `${finalResponse}\n`);
	return {
		session_id: gradedSession.session_id!,
		prompt_ref: gradedSession.prompt_ref!,
		final_response: finalResponse,
		event_count: events.length,
		message_count: session.messages.length,
		status,
		error,
	};
}

function verifierCommands(task: TaskYaml, includeHidden: boolean): VerifierCommand[] {
	const verifiers = task.memswe?.verifiers;
	const groups: Array<[VerifierKind, VerifierSpec[] | undefined]> = [
		["visible", verifiers?.visible_tests],
		["protected", verifiers?.protected_tests],
	];
	if (includeHidden) groups.push(["hidden", verifiers?.hidden_tests]);

	return groups.flatMap(([kind, specs]) =>
		(specs ?? []).map((spec, index) => {
			if (!spec.command) {
				throw new Error(`Verifier ${kind}[${index}] is missing command`);
			}
			return {
				id: spec.id ?? `${kind}-${index + 1}`,
				kind,
				command: spec.command,
			};
		}),
	);
}

async function runCommand(command: VerifierCommand, cwd: string, timeoutMs: number, shimDir: string): Promise<CommandResult> {
	const start = Date.now();
	return new Promise((resolveCommand) => {
		const child = spawn(command.command, {
			cwd,
			env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ""}` },
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolveCommand({
				...command,
				exit_code: timedOut ? null : code,
				signal,
				stdout,
				stderr: timedOut ? `${stderr}\nTimed out after ${timeoutMs}ms` : stderr,
				duration_ms: Date.now() - start,
			});
		});
	});
}

async function copyVerifierFiles(taskDir: string, workdir: string, task: TaskYaml, includeHidden: boolean): Promise<void> {
	const assets = inferVerifierAssets(taskDir, workdir, task, includeHidden);
	for (const asset of assets) {
		await mkdir(dirname(asset.destination), { recursive: true });
		await copyFile(asset.source, asset.destination);
	}
}

async function main(): Promise<void> {
	const taskId = getArgumentValue("--task-id") ?? DEFAULT_TASK_ID;
	const includeHidden = hasFlag("--include-hidden");
	const skipFauxAgent = hasFlag("--skip-faux-agent");
	const taskDir = join(MEMSWE_ROOT, "tasks", taskId);
	const taskYamlPath = join(taskDir, "task.yaml");
	const parsed = parse(await readFile(taskYamlPath, "utf8"));
	if (!isTaskYaml(parsed)) throw new Error(`Expected object task YAML at ${taskYamlPath}`);

	const now = new Date();
	const timestamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
	const runId = `memswe-smoke-${taskId}-${timestamp}`;
	const artifactsDir = join(RUNS_ROOT, timestamp, taskId);
	const workdir = join(tmpdir(), runId, "worktree");
	await rm(dirname(workdir), { recursive: true, force: true });
	await mkdir(workdir, { recursive: true });
	await cp(join(taskDir, "fixture"), workdir, { recursive: true });
	await copyVerifierFiles(taskDir, workdir, parsed, includeHidden);
	await mkdir(artifactsDir, { recursive: true });
	const pythonEnvironment = await preparePythonEnvironment(workdir, parsed.harbor?.environment?.setup_command);
	if (pythonEnvironment.setupResult) {
		await writeFile(join(artifactsDir, "setup-result.json"), `${JSON.stringify(pythonEnvironment.setupResult, null, "	")}\n`);
		console.log(
			`Finished setup command with exit ${pythonEnvironment.setupResult.exit_code ?? `signal ${pythonEnvironment.setupResult.signal ?? "timeout"}`}`,
		);
	}

	const fauxAgentResult = skipFauxAgent ? undefined : await runFauxAgentSession(parsed, taskDir, workdir, artifactsDir);
	if (fauxAgentResult) {
		console.log(
			`Faux agent session ${fauxAgentResult.session_id} finished with ${fauxAgentResult.status}; captured ${fauxAgentResult.event_count} event(s).`,
		);
	}

	const timeoutMs = (parsed.harbor?.verifier?.timeout_sec ?? 1800) * 1000;
	const commands = verifierCommands(parsed, includeHidden);
	const skippedHiddenCommands = includeHidden
		? []
		: verifierCommands(parsed, true).filter((command) => command.kind === "hidden");
	if (skippedHiddenCommands.length > 0) {
		console.log(
			`Isolated ${skippedHiddenCommands.length} hidden verifier(s); pass --include-hidden to run them in the temp worktree.`,
		);
	}
	const results: CommandResult[] = [];
	for (const command of commands) {
		console.log(`Running ${command.kind} verifier ${command.id}: ${command.command}`);
		const result = await runCommand(command, workdir, timeoutMs, pythonEnvironment.shimDir);
		results.push(result);
		console.log(`Finished ${command.id} with exit ${result.exit_code ?? `signal ${result.signal ?? "timeout"}`}`);
	}

	const visible = results.filter((result) => result.kind === "visible");
	const hidden = results.filter((result) => result.kind === "hidden");
	const protectedResults = results.filter((result) => result.kind === "protected");
	const passed = (items: CommandResult[]) => items.filter((item) => item.exit_code === 0).length;
	const f2pTotal = hidden.length;
	const f2pPassed = passed(hidden);
	const p2pTotal = protectedResults.length;
	const p2pPassed = passed(protectedResults);
	const verifiersPassed = results.length > 0 && passed(results) === results.length;
	const agentPassed = fauxAgentResult?.status !== "errored";
	const allPassed = verifiersPassed && agentPassed;
	const condition = parsed.memswe?.memory_conditions?.[0];
	const record: RunRecord = {
		run_id: runId,
		task_id: parsed.harbor?.metadata?.task_id ?? taskId,
		schema_version: "uam-run.v0.1",
		condition: {
			condition_id: condition?.id ?? "no_memory",
			memory_system: condition?.memory_system ?? null,
			baseline_kind: "verifier_only_smoke",
			model_id: "none/verifier-only",
			repetition_index: 1,
			k: 1,
		},
		session_results: [
			{
				session_id: fauxAgentResult?.session_id ?? "s3",
				status: allPassed ? "completed" : "errored",
				trace_id: null,
				artifact_paths: {
					workdir,
					agent_events: join(artifactsDir, "agent-events.json"),
					agent_messages: join(artifactsDir, "agent-messages.json"),
					agent_final_response: join(artifactsDir, "agent-final-response.txt"),
					verifier_results: join(artifactsDir, "verifier-results.json"),
					skipped_hidden_verifiers: join(artifactsDir, "skipped-hidden-verifiers.json"),
				},
			},
		],
		reward: {
			reward: allPassed ? 1 : 0,
			f2p_total: f2pTotal,
			f2p_passed: f2pPassed,
			p2p_total: p2pTotal,
			p2p_passed: p2pPassed,
			f2p: f2pTotal === 0 ? 0 : f2pPassed / f2pTotal,
			p2p: p2pTotal === 0 ? 0 : p2pPassed / p2pTotal,
			partial: results.length === 0 ? 0 : passed(results) / results.length,
			apply_failed: 0,
		},
		metric_vector: {
			task_success_visible: visible.length === 0 ? null : passed(visible) / visible.length,
			task_success_hidden: hidden.length === 0 ? null : passed(hidden) / hidden.length,
			per_task_cost_usd: 0,
			end_to_end_task_latency_ms: results.reduce((sum, result) => sum + result.duration_ms, 0),
			memory_retrieval_latency_p50_ms: null,
			memory_retrieval_latency_p95_ms: null,
			total_tokens: 0,
			input_tokens: 0,
			output_tokens: 0,
			thinking_tokens: null,
			context_tokens_required: null,
			session_bootstrap_information: null,
			memory_operation_tool_calls_by_type: {},
			memory_operation_tool_call_share: 0,
			injected_memory_tokens: 0,
			injected_memory_token_share: 0,
			memory_utilization_rate: null,
			cross_session_improvement_curve: null,
			time_to_first_productive_action_ms: null,
			memory_consolidation_settle_time_ms: null,
			tool_call_count: 0,
			stale_use_rate: null,
			leakage_count: null,
			repeated_failed_action_count: null,
			trace_coverage: null,
		},
		trace_predicate_results: (parsed.memswe?.trace_predicates ?? []).map((predicate) => ({
			id: predicate.id ?? "unknown",
			outcome: "not_evaluable",
			severity: predicate.severity ?? "diagnostic",
			evidence_ref: null,
		})),
		primary_failure_category: allPassed ? null : "task_failure",
		output_locations: {
			trace_store_ref: join(artifactsDir, "verifier-results.json"),
			postgres_run_ref: null,
			artifacts_dir: artifactsDir,
		},
	};

	await writeFile(join(artifactsDir, "faux-agent-result.json"), `${JSON.stringify(fauxAgentResult ?? null, null, "	")}\n`);
	await writeFile(join(artifactsDir, "verifier-results.json"), `${JSON.stringify(results, null, "	")}\n`);
	await writeFile(
		join(artifactsDir, "skipped-hidden-verifiers.json"),
		`${JSON.stringify(skippedHiddenCommands, null, "	")}\n`,
	);
	await writeFile(join(artifactsDir, "run-record.json"), `${JSON.stringify(record, null, "	")}\n`);
	console.log(`Wrote ${relative(REPO_ROOT, join(artifactsDir, "run-record.json"))}`);
	if (!allPassed) process.exitCode = 1;
}

await main();
