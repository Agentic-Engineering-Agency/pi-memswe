#!/usr/bin/env -S npx tsx

import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import {
	discoverTaskIds,
	inferVerifierAssets,
	initializeWorktreeBaseline,
	preparePythonEnvironment,
	scrubSecretEnv,
	type SessionSpec,
	type TaskYaml,
	validateRunRecordAgainstSchema,
	validateRunRecordShape,
	validFactsBeforeSession,
	type VerifierSpec,
	writePatchArtifacts,
	collectPriorTranscripts,
	renderFullContextPreamble,
	type PriorTranscript,
	resolveModelPricing,
} from "./memswe-smoke-runner-lib.ts";
import { createMemSweTrace, isMemSweOtlpExportConfigured, memoryLatencySummary, traceCompletenessSummary } from "./memswe-trace-scaffold.ts";
import { runFilesystemLifecycleSmoke } from "./memswe-adapter-filesystem.ts";
import { runLocalRagLifecycleSmoke } from "./memswe-adapter-localrag.ts";
import { runZepLifecycleSmoke } from "./memswe-adapter-zep.ts";
import { runSupermemoryLifecycleSmoke } from "./memswe-adapter-supermemory.ts";
import { runHonchoLifecycleSmoke, runHonchoGradedMemory, readbackHonchoWorkspace } from "./memswe-adapter-honcho.ts";
import type { HonchoGradedMemoryResult } from "./memswe-adapter-honcho.ts";
import { runGraphitiLifecycleSmoke } from "./memswe-adapter-graphiti.ts";
import { runMem0LifecycleSmoke } from "./memswe-adapter-mem0.ts";
import { runLettaLifecycleSmoke } from "./memswe-adapter-letta.ts";
import { runHindsightLifecycleSmoke } from "./memswe-hindsight-smoke.ts";

const DEFAULT_TASK_ID = "repo-gamma-invoice-export-001";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const MEMSWE_ROOT = resolve(REPO_ROOT, "../memswe");
const RUNS_ROOT = join(REPO_ROOT, ".memswe-runs");
const PROVIDER_CONDITION_IDS = ["filesystem", "localrag", "zep", "supermemory", "honcho", "graphiti", "mem0", "letta", "hindsight"] as const;
const MEMORY_CONDITION_IDS = ["no_memory", "full_context", "repository_docs", ...PROVIDER_CONDITION_IDS] as const;
// AGE-184: each provider condition runs the corresponding AMS adapter lifecycle smoke so run-records
// carry condition.memory_system = <provider> and baseline_kind = adapter_lifecycle_smoke. Cloud
// adapters self-report status "skipped" (not "failed") when their API key is unset, so wiring is
// verifiable without every vendor credential present.
const PROVIDER_LIFECYCLE_SMOKES: Record<(typeof PROVIDER_CONDITION_IDS)[number], () => Promise<{ status: string; predicate_results?: Record<string, boolean>; export?: unknown }>> = {
	filesystem: runFilesystemLifecycleSmoke,
	localrag: runLocalRagLifecycleSmoke,
	zep: runZepLifecycleSmoke,
	supermemory: runSupermemoryLifecycleSmoke,
	honcho: runHonchoLifecycleSmoke,
	graphiti: runGraphitiLifecycleSmoke,
	mem0: runMem0LifecycleSmoke,
	letta: runLettaLifecycleSmoke,
	hindsight: runHindsightLifecycleSmoke,
};
const AGENT_MODE_IDS = ["faux-text", "real", "minimax-real"] as const;

type VerifierKind = "visible" | "hidden" | "protected";
type MemoryConditionId = (typeof MEMORY_CONDITION_IDS)[number];
type AgentMode = (typeof AGENT_MODE_IDS)[number];


type VerifierCommand = {
	id: string;
	kind: VerifierKind;
	command: string;
	f2p: boolean;
	p2p: boolean;
};

type CommandResult = VerifierCommand & {
	exit_code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	duration_ms: number;
};
type RewardBlock = {
	reward: 1;
	f2p_total: number;
	f2p_passed: number;
	p2p_total: number;
	p2p_passed: number;
	f2p: number;
	p2p: number;
	partial: number;
	apply_failed: 0 | 1;
};


type AgentRunResult = {
	session_id: string;
	prompt_ref: string;
	final_response: string;
	event_count: number;
	message_count: number;
	status: "completed" | "errored";
	error: string | null;
	agent_mode: AgentMode;
	model_id: string;
	provider_id: string;
	base_url: string;
	total_tokens?: number;
	input_tokens?: number;
	output_tokens?: number;
	cost_usd?: number;
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
	reward?: RewardBlock;
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

type TaskRunResult = {
	taskId: string;
	allPassed: boolean;
	runRecordPath: string;
};

type SuiteTaskResult = {
	task_id: string;
	status: "passed" | "failed";
	run_record: string | null;
	failed_phase: string | null;
	error: string | null;
};

type ConditionPrepareResult = {
	condition_id: MemoryConditionId;
	memory_system: string | null;
	artifact_paths: Record<string, string>;
	honcho_memory?: HonchoGradedMemoryResult;
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

function parseConditionId(value: string | undefined): MemoryConditionId {
	const conditionId = value ?? "no_memory";
	if (MEMORY_CONDITION_IDS.includes(conditionId as MemoryConditionId)) return conditionId as MemoryConditionId;
	throw new Error(`Invalid --condition=${conditionId}; expected one of ${MEMORY_CONDITION_IDS.join(", ")}`);
}

function parseAgentMode(value: string | undefined): AgentMode {
	const val = value === "faux" ? "faux-text" : value;
	const agentMode = val ?? "faux-text";
	if (AGENT_MODE_IDS.includes(agentMode as AgentMode)) return agentMode as AgentMode;
	throw new Error(`Invalid --agent-mode=${agentMode}; expected one of ${AGENT_MODE_IDS.join(", ")}`);
}

function parseRepetitionIndex(value: string | undefined): number {
	if (value === undefined) return 1;
	const n = Number.parseInt(value, 10);
	if (!Number.isInteger(n) || n < 1) {
		throw new Error(`Invalid --repetition-index=${value}; expected a positive integer (1-based)`);
	}
	return n;
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

export function resolveRunSessionId(task: TaskYaml, agentResult?: Pick<AgentRunResult, "session_id">): string {
	if (agentResult) return agentResult.session_id;
	return resolveGradedSession(task).session_id!;
}

type ScoreRewardInput = Pick<CommandResult, "kind" | "exit_code"> & {
	f2p?: boolean;
	p2p?: boolean;
};

export function scoreReward(results: ScoreRewardInput[]): RewardBlock | undefined {
	const f2pResults = results.filter((result) => result.kind === "hidden" && result.f2p !== false);
	if (f2pResults.length === 0 || f2pResults.some((result) => result.exit_code !== 0)) return undefined;

	const p2pResults = results.filter((result) => result.kind === "protected" || result.p2p === true);
	const passed = (items: ScoreRewardInput[]) => items.filter((item) => item.exit_code === 0).length;
	return {
		reward: 1,
		f2p_total: f2pResults.length,
		f2p_passed: passed(f2pResults),
		p2p_total: p2pResults.length,
		p2p_passed: passed(p2pResults),
		f2p: 1,
		p2p: p2pResults.length === 0 ? 0 : passed(p2pResults) / p2pResults.length,
		partial: results.length === 0 ? 0 : passed(results) / results.length,
		apply_failed: 0,
	};
}

export function classifyPrimaryFailureCategory(
	agentResult: Pick<AgentRunResult, "status"> | undefined,
	allPassed: boolean,
): RunRecord["primary_failure_category"] {
	if (agentResult?.status === "errored") return "process_failure";
	return allPassed ? null : "task_failure";
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

async function runFauxAgentSession(
	task: TaskYaml,
	taskDir: string,
	workdir: string,
	artifactsDir: string,
	priorTranscripts?: PriorTranscript[],
	memoryPreamble?: string,
): Promise<AgentRunResult> {
	const gradedSession = resolveGradedSession(task);
	const gradedPrompt = await readFile(join(taskDir, gradedSession.prompt_ref!), "utf8");
	const fullContextPreamble = priorTranscripts ? renderFullContextPreamble(priorTranscripts) : "";
	const prompt = [memoryPreamble, fullContextPreamble, gradedPrompt].filter((part) => part && part.length > 0).join("\n");
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

	let status: AgentRunResult["status"] = "completed";
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
		agent_mode: "faux-text",
		model_id: model.id,
		provider_id: model.provider,
		base_url: model.baseUrl,
	};
}

async function runRealAgentSession(
	task: TaskYaml,
	taskDir: string,
	workdir: string,
	artifactsDir: string,
	priorTranscripts?: PriorTranscript[],
	memoryPreamble?: string,
): Promise<AgentRunResult> {
	const gradedSession = resolveGradedSession(task);
	const gradedPrompt = await readFile(join(taskDir, gradedSession.prompt_ref!), "utf8");
	const fullContextPreamble = priorTranscripts ? renderFullContextPreamble(priorTranscripts) : "";
	const prompt = [memoryPreamble, fullContextPreamble, gradedPrompt].filter((part) => part && part.length > 0).join("\n");
	if (process.env.MEMSWE_ALLOW_REAL_MODEL !== "1") {
		throw new Error("--agent-mode=real requires MEMSWE_ALLOW_REAL_MODEL=1 to confirm intentional real-model spend.");
	}

	const providerId = process.env.MEMSWE_LLM_PROVIDER ?? "omniroute";
	const modelId = process.env.MEMSWE_LLM_MODEL ?? "azure/deepseek-v4-flash";
	const apiKey = process.env.MEMSWE_LLM_API_KEY ?? process.env.OMNIROUTE_API_KEY;
	const baseUrl = process.env.MEMSWE_LLM_BASE_URL ?? process.env.OMNIROUTE_BASE_URL;

	if (!apiKey) {
		throw new Error("--agent-mode=real requires MEMSWE_LLM_API_KEY or OMNIROUTE_API_KEY in the environment.");
	}

	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(providerId, apiKey);
	const modelRegistry = ModelRegistry.inMemory(authStorage);

	let model = modelRegistry.find(providerId, modelId);
	if (!model && baseUrl) {
		const pricing = resolveModelPricing(modelId, process.env);
		if (pricing.source === "none") {
			console.warn(`[Cost Registry] WARNING: No pricing config for ${modelId}. Set MEMSWE_LLM_INPUT_COST_PER_M and MEMSWE_LLM_OUTPUT_COST_PER_M to enable non-zero cost tracking. Defaulting to 0.`);
		} else {
			console.log(`[Cost Registry] Registering model ${modelId} with pricing: ${pricing.input} input, ${pricing.output} output per 1M tokens (source: ${pricing.source}).`);
		}

		modelRegistry.registerProvider(providerId, {
			baseUrl,
			apiKey,
			api: "openai-completions" as unknown as import("@earendil-works/pi-ai").Api,
			models: [{
				id: modelId,
				name: modelId,
				api: "openai-completions" as unknown as import("@earendil-works/pi-ai").Api,
				reasoning: false,
				input: ["text"],
				cost: {
					input: pricing.input,
					output: pricing.output,
					cacheRead: pricing.cacheRead,
					cacheWrite: pricing.cacheWrite,
				},
				contextWindow: 128000,
				maxTokens: 8192,
			}],
		});
		model = modelRegistry.find(providerId, modelId);
	}

	if (!model) throw new Error(`Model ${modelId} is not registered for provider ${providerId}`);

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

	let status: AgentRunResult["status"] = "completed";
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
	}

	const assistantMessages = session.messages.filter(
		(message): message is Extract<typeof message, { role: "assistant" }> => message.role === "assistant",
	);
	const finalResponse = messageText(assistantMessages.at(-1));
	await writeFile(join(artifactsDir, "agent-final-response.txt"), `${finalResponse}\n`);

	// Surface model-side failures (e.g. 404 "No active credentials") as run errors.
	// session.prompt() does not throw on these; the failure lands on the assistant
	// message's stopReason/errorMessage. Without this, zero-inference failures look green.
	if (status !== "errored") {
		const failed = assistantMessages.find(
			(message) => message.stopReason === "error" || message.stopReason === "aborted",
		);
		if (failed) {
			status = "errored";
			error = failed.errorMessage ?? `Model stopped with reason "${failed.stopReason}"`;
		}
	}

	// Propagate real token usage into the result so metric_vector is not stuck at 0.
	// input_tokens follows the established convention (usage.input + usage.cacheRead).
	let input_tokens = 0;
	let output_tokens = 0;
	let cost_usd = 0;
	for (const message of assistantMessages) {
		if (message.stopReason === "error" || message.stopReason === "aborted") continue;
		input_tokens += message.usage.input + message.usage.cacheRead;
		output_tokens += message.usage.output;
		cost_usd += message.usage.cost?.total ?? 0;
	}
	const total_tokens = input_tokens + output_tokens;

	return {
		session_id: gradedSession.session_id!,
		prompt_ref: gradedSession.prompt_ref!,
		final_response: finalResponse,
		event_count: events.length,
		message_count: session.messages.length,
		status,
		error,
		agent_mode: "real",
		model_id: model.id,
		provider_id: model.provider,
		base_url: model.baseUrl,
		total_tokens,
		input_tokens,
		output_tokens,
		cost_usd,
	};
}

async function runAgentSession(
	agentMode: AgentMode,
	task: TaskYaml,
	taskDir: string,
	workdir: string,
	artifactsDir: string,
	priorTranscripts?: PriorTranscript[],
	memoryPreamble?: string,
): Promise<AgentRunResult> {
	if (agentMode === "real" || agentMode === "minimax-real") return runRealAgentSession(task, taskDir, workdir, artifactsDir, priorTranscripts, memoryPreamble);
	return runFauxAgentSession(task, taskDir, workdir, artifactsDir, priorTranscripts, memoryPreamble);
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
				f2p: spec.f2p === true || kind === "hidden",
				p2p: spec.p2p === true || kind === "protected",
			};
		}),
	);
}

async function runCommand(command: VerifierCommand, cwd: string, timeoutMs: number, shimDir: string): Promise<CommandResult> {
	const start = Date.now();
	return new Promise((resolveCommand) => {
		const child = spawn(command.command, {
			cwd,
			env: verifierEnvironment(shimDir),
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

function verifierEnvironment(shimDir: string): NodeJS.ProcessEnv {
	return scrubSecretEnv(shimDir);
}

async function copyVerifierFiles(taskDir: string, workdir: string, task: TaskYaml, includeHidden: boolean): Promise<void> {
	const assets = inferVerifierAssets(taskDir, workdir, task, includeHidden);
	for (const asset of assets) {
		await mkdir(dirname(asset.destination), { recursive: true });
		await copyFile(asset.source, asset.destination);
	}
}
async function prepareCondition(conditionId: MemoryConditionId, task: TaskYaml, workdir: string, artifactsDir: string, taskDir: string, runId: string): Promise<ConditionPrepareResult> {
	const isProvider = (PROVIDER_CONDITION_IDS as readonly string[]).includes(conditionId);
	if (conditionId !== "no_memory" && conditionId !== "repository_docs" && conditionId !== "full_context" && !isProvider) {
		throw new Error(`Memory condition ${conditionId} is not implemented`);
	}
	const conditionResultPath = join(artifactsDir, "condition-result.json");
	const artifactPaths: Record<string, string> = { condition_result: conditionResultPath };
	let memorySystem: string | null = null;
	let honchoMemory: HonchoGradedMemoryResult | undefined;
	if (conditionId === "repository_docs") {
		const docsPath = join(workdir, "docs/agent-project-memory/memswe-facts.md");
		const docsArtifactPath = join(artifactsDir, "repository-docs/memswe-facts.md");
		const docs = repositoryDocsMarkdown(task);
		await mkdir(dirname(docsPath), { recursive: true });
		await mkdir(dirname(docsArtifactPath), { recursive: true });
		await writeFile(docsPath, docs);
		await writeFile(docsArtifactPath, docs);
		artifactPaths.repository_docs = docsArtifactPath;
	} else if (conditionId === "full_context") {
		// full_context: replay prior non-graded session transcripts before graded prompt.
		// memory_system = full_context so run-record validates.
		memorySystem = "full_context";
		const transcriptPath = join(artifactsDir, "full-context-transcript.json");
		const prior = collectPriorTranscripts(task, taskDir);
		await writeFile(transcriptPath, `${JSON.stringify(prior, null, "	")}\n`);
		artifactPaths.full_context_transcript = transcriptPath;
	} else if (conditionId === "honcho") {
		// AGE-206: honcho graded runs use a PERSISTENT, per-run-isolated Honcho workspace instead of the
		// self-deleting lifecycle smoke. Seed the valid remembered facts into the run-scoped workspace, then
		// recall a memory preamble that is injected into the graded prompt. The workspace is NOT deleted so
		// that a post-session readback (see runTask) can prove peer + conclusion/derived data landed.
		const gradedSession = resolveGradedSession(task);
		const facts = validFactsBeforeSession(task, gradedSession.session_id!)
			.map((fact) => fact.text)
			.filter((text): text is string => typeof text === "string" && text.length > 0);
		const recallQuery = "Summarize everything you remember about this project from prior sessions.";
		const mem = await runHonchoGradedMemory({ scopeId: runId, facts, recallQuery });
		const memPath = join(artifactsDir, "honcho-graded-memory.json");
		await writeFile(memPath, `${JSON.stringify(mem, null, "	")}\n`);
		artifactPaths.honcho_graded_memory = memPath;
		memorySystem = "honcho";
		honchoMemory = mem;
	} else if (isProvider) {
		// Run the adapter lifecycle smoke for this provider and record it. A cloud provider with no
		// API key returns status "skipped" (not "failed"); either way memory_system is the provider id
		// so the run-record reflects the condition actually exercised.
		const smoke = await PROVIDER_LIFECYCLE_SMOKES[conditionId as (typeof PROVIDER_CONDITION_IDS)[number]]();
		const smokePath = join(artifactsDir, `provider-smoke-${conditionId}.json`);
		await writeFile(smokePath, `${JSON.stringify(smoke, null, "	")}\n`);
		artifactPaths.provider_smoke = smokePath;
		memorySystem = conditionId;
	}
	const result: ConditionPrepareResult = {
		condition_id: conditionId,
		memory_system: memorySystem,
		artifact_paths: artifactPaths,
		honcho_memory: honchoMemory,
	};
	await writeFile(conditionResultPath, `${JSON.stringify(result, null, "	")}\n`);
	return result;
}

function repositoryDocsMarkdown(task: TaskYaml): string {
	const gradedSession = resolveGradedSession(task);
	const facts = validFactsBeforeSession(task, gradedSession.session_id!);
	const taskId = task.harbor?.metadata?.task_id ?? DEFAULT_TASK_ID;
	return `${[
		"# Agent Project Memory",
		"",
		`Task: ${taskId}`,
		"Condition: repository_docs",
		"",
		"## Valid remembered facts",
		"",
		...facts.map((fact) => `- ${fact.text}`),
	].join("\n")}\n`;
}


async function runTask(
	taskId: string,
	timestamp: string,
	includeHidden: boolean,
	skipFauxAgent: boolean,
	conditionId: MemoryConditionId,
	agentMode: AgentMode,
	traceEnabled: boolean,
	repetitionIndex: number,
): Promise<TaskRunResult> {
	const taskDir = join(MEMSWE_ROOT, "tasks", taskId);
	const taskYamlPath = join(taskDir, "task.yaml");
	const parsed = parse(await readFile(taskYamlPath, "utf8"));
	if (!isTaskYaml(parsed)) throw new Error(`Expected object task YAML at ${taskYamlPath}`);

	// AGE-206: carry condition + repetition into the run id so runs are namespace-isolated and auditable.
	// The honcho condition derives its per-run Honcho workspace id from this scope, so it must be unique
	// per (task, condition, repetition, timestamp) or repetitions would share a workspace.
	const runSlug = `${taskId}-${conditionId}-r${repetitionIndex}`;
	const runId = `memswe-smoke-${runSlug}-${timestamp}`;
	const trace = createMemSweTrace(runId, traceEnabled);
	const benchmarkSpan = trace.startSpan("benchmark", "benchmark.run", { task_id: taskId, condition_id: conditionId, agent_mode: agentMode });
	const artifactsDir = join(RUNS_ROOT, timestamp, `${taskId}-${conditionId}-r${repetitionIndex}`);
	const workdir = join(tmpdir(), runId, "worktree");
	const repoDir = join(workdir, "fixture");
	await rm(dirname(workdir), { recursive: true, force: true });
	await mkdir(workdir, { recursive: true });
	await cp(join(taskDir, "fixture"), repoDir, { recursive: true });
	await copyVerifierFiles(taskDir, workdir, parsed, includeHidden);
	await mkdir(artifactsDir, { recursive: true });
	const memorySpan = trace.startSpan("memory", "memory.prepare", { condition_id: conditionId });
	const conditionResult = await prepareCondition(conditionId, parsed, repoDir, artifactsDir, taskDir, runId);
	memorySpan.end();
	await initializeWorktreeBaseline(repoDir);

	const agentSessionStart = performance.now();
	const priorTranscripts = conditionId === "full_context" ? collectPriorTranscripts(parsed, taskDir) : undefined;
	// AGE-206: honcho graded runs read their seeded per-run Honcho workspace via a recall preamble, then
	// write the graded outcome back and assert readback (peer + conclusion/derived data) AFTER the session.
	const honchoMemory = conditionResult.honcho_memory;
	const memoryPreamble = honchoMemory?.preamble;
	const agentResult = skipFauxAgent
		? undefined
		: await runAgentSession(agentMode, parsed, taskDir, repoDir, artifactsDir, priorTranscripts, memoryPreamble);
	const agentSessionLatencyMs = skipFauxAgent ? 0 : Math.round(performance.now() - agentSessionStart);
	if (agentResult) {
		console.log(
			`${agentResult.agent_mode} agent session ${agentResult.session_id} finished with ${agentResult.status}; captured ${agentResult.event_count} event(s).`,
		);
	}
	// AGE-206: after the graded honcho session, write the agent's conclusion back into the SAME per-run
	// Honcho workspace and assert readback (peer representation + conclusion/derived data). The workspace is
	// never deleted, so this proves persisted graded memory rather than a throwaway lifecycle smoke.
	let honchoReadbackPassed = true;
	if (conditionId === "honcho" && honchoMemory) {
		const agentConclusion = agentResult?.final_response?.trim() || "(no agent output captured for this run)";
		const conclusionText = `[graded-conclusion ${runId}] ${agentConclusion}`.slice(0, 4000);
		const readback: Record<string, unknown> =
			honchoMemory.status === "ready"
				? await readbackHonchoWorkspace({ scopeId: runId, conclusionText })
				: {
						schema_version: "memswe-honcho-readback.v0.1",
						created_at: new Date().toISOString(),
						scope_id: runId,
						status: "skipped",
						reason: `graded honcho memory was ${honchoMemory.status}; no persistent workspace to read back`,
					};
		const readbackPath = join(artifactsDir, "honcho-readback.json");
		await writeFile(readbackPath, `${JSON.stringify(readback, null, "	")}\n`);
		conditionResult.artifact_paths.honcho_readback = readbackPath;
		// AGE-206 acceptance requires a POSITIVE readback (peer + conclusion data). A skipped/failed readback
		// means the graded honcho memory was never proven, so the run must not be reported as passing.
		honchoReadbackPassed = readback.status === "passed";
		console.log(`honcho readback for ${runId}: ${String(readback.status)} (run_gate=${honchoReadbackPassed})`);
	}
	const patchArtifacts = await writePatchArtifacts(repoDir, artifactsDir);
	const pythonEnvironment = await preparePythonEnvironment(repoDir, parsed);
	if (pythonEnvironment.setupResult) {
		await writeFile(join(artifactsDir, "setup-result.json"), `${JSON.stringify(pythonEnvironment.setupResult, null, "	")}\n`);
		console.log(
			`Finished setup command with exit ${pythonEnvironment.setupResult.exit_code ?? `signal ${pythonEnvironment.setupResult.signal ?? "timeout"}`}`,
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
		const verifierSpan = trace.startSpan("verifier", `verifier.${command.kind}`, { verifier_id: command.id, verifier_kind: command.kind });
		const result = await runCommand(command, workdir, timeoutMs, pythonEnvironment.shimDir);
		verifierSpan.end();
		results.push(result);
		console.log(`Finished ${command.id} with exit ${result.exit_code ?? `signal ${result.signal ?? "timeout"}`}`);
	}

	const scoringSpan = trace.startSpan("scoring", "scoring.reward");
	const visible = results.filter((result) => result.kind === "visible");
	const hidden = results.filter((result) => result.kind === "hidden");
	const protectedResults = results.filter((result) => result.kind === "protected");
	const passed = (items: CommandResult[]) => items.filter((item) => item.exit_code === 0).length;
	const reward = scoreReward(results);
	const verifiersPassed = results.length > 0 && passed(results) === results.length;
	const agentPassed = agentResult?.status !== "errored";
	const allPassed = verifiersPassed && agentPassed && honchoReadbackPassed;
	scoringSpan.end();
	benchmarkSpan.end();
	const traceArtifact = trace.toArtifact();
	const traceCompleteness = traceCompletenessSummary(traceArtifact);
	const memoryLatency = memoryLatencySummary(traceArtifact);
	const traceFlush = await trace
		.flush()
		.then((result) => ({ ok: true, error: null as string | null, result }))
		.catch((error: unknown) => ({
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			result: null,
		}));
	const traceArtifactPath = join(artifactsDir, "memswe-trace.json");
	const record: RunRecord = {
		run_id: runId,
		task_id: parsed.harbor?.metadata?.task_id ?? taskId,
		schema_version: "uam-run.v0.1",
		condition: {
			condition_id: conditionResult.condition_id,
			memory_system: conditionResult.memory_system,
			baseline_kind:
				conditionResult.condition_id === "honcho"
					? "honcho_persistent_graded_memory"
					: conditionResult.memory_system
						? "adapter_lifecycle_smoke"
						: "verifier_only_smoke",
			model_id: agentResult ? `${agentResult.provider_id}/${agentResult.model_id}` : "none/verifier-only",
			repetition_index: repetitionIndex,
			k: 1,
		},
		session_results: [
			{
				session_id: resolveRunSessionId(parsed, agentResult),
				status: allPassed ? "completed" : "errored",
				trace_id: trace.traceId,
				artifact_paths: {
					workdir,
					agent_result: join(artifactsDir, "agent-result.json"),
					agent_events: join(artifactsDir, "agent-events.json"),
					agent_messages: join(artifactsDir, "agent-messages.json"),
					agent_final_response: join(artifactsDir, "agent-final-response.txt"),
					agent_patch: patchArtifacts.agentPatch,
					worktree_diff: patchArtifacts.worktreeDiff,
					changed_files: patchArtifacts.changedFiles,
					trace_artifact: traceArtifactPath,
					...conditionResult.artifact_paths,
					verifier_results: join(artifactsDir, "verifier-results.json"),
					skipped_hidden_verifiers: join(artifactsDir, "skipped-hidden-verifiers.json"),
				},
			},
		],
		...(reward ? { reward } : {}),
		metric_vector: {
			task_success_visible: !agentPassed ? null : visible.length === 0 ? null : passed(visible) / visible.length,
			task_success_hidden: !agentPassed ? null : hidden.length === 0 ? null : passed(hidden) / hidden.length,
			per_task_cost_usd: agentResult?.cost_usd ?? 0,
			end_to_end_task_latency_ms: agentSessionLatencyMs + results.reduce((sum, result) => sum + result.duration_ms, 0),
			memory_retrieval_latency_p50_ms: memoryLatency.p50_ms,
			memory_retrieval_latency_p95_ms: memoryLatency.p95_ms,
			total_tokens: agentResult?.total_tokens ?? 0,
			input_tokens: agentResult?.input_tokens ?? 0,
			output_tokens: agentResult?.output_tokens ?? 0,
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
			trace_coverage: trace.enabled ? traceCompleteness.traceCoverage : null,
		},
		trace_predicate_results: [
			...(parsed.memswe?.trace_predicates ?? []).map((predicate) => ({
				id: predicate.id ?? "unknown",
				outcome: "not_evaluable" as const,
				severity: predicate.severity ?? "diagnostic",
				evidence_ref: null,
			})),
			{
				id: "otel_trace_complete",
				outcome: trace.enabled ? (traceCompleteness.complete && traceFlush.ok ? "pass" : "fail") : "not_evaluable",
				severity: "diagnostic",
				evidence_ref: trace.enabled ? traceArtifactPath : null,
			},
		],
		primary_failure_category: classifyPrimaryFailureCategory(agentResult, allPassed),
		output_locations: {
			trace_store_ref: trace.traceStoreRef ?? join(artifactsDir, "verifier-results.json"),
			postgres_run_ref: null,
			artifacts_dir: artifactsDir,
		},
	};
	validateRunRecordShape(record);
	validateRunRecordAgainstSchema(record, join(MEMSWE_ROOT, "schema", "run-record.schema.json"));

	await writeFile(join(artifactsDir, "agent-result.json"), `${JSON.stringify(agentResult ?? null, null, "	")}\n`);
	await writeFile(join(artifactsDir, "verifier-results.json"), `${JSON.stringify(results, null, "	")}\n`);
	await writeFile(
		join(artifactsDir, "skipped-hidden-verifiers.json"),
		`${JSON.stringify(skippedHiddenCommands, null, "	")}\n`,
	);
	await writeFile(traceArtifactPath, `${JSON.stringify(traceArtifact, null, "	")}\n`);
	const runRecordPath = join(artifactsDir, "run-record.json");
	await writeFile(runRecordPath, `${JSON.stringify(record, null, "	")}\n`);
	if (trace.enabled && !traceFlush.ok) {
		console.warn(
			`MemSWE OTLP flush failed (run-record written, marking run non-green): ${traceFlush.error}`,
		);
		process.exitCode = 1;
	}
	console.log(`Wrote ${relative(REPO_ROOT, runRecordPath)}`);
	return { taskId, allPassed, runRecordPath };
}

async function main(): Promise<void> {
	const includeHidden = hasFlag("--include-hidden");
	const skipFauxAgent = hasFlag("--skip-faux-agent");
	const conditionId = parseConditionId(getArgumentValue("--condition"));
	const agentMode = parseAgentMode(getArgumentValue("--agent-mode"));
	const repetitionIndex = parseRepetitionIndex(getArgumentValue("--repetition-index"));
	const traceEnabled = !hasFlag("--no-otel-trace") && (hasFlag("--otel-trace") || isMemSweOtlpExportConfigured());
	const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	if (!hasFlag("--all-tasks")) {
		const result = await runTask(getArgumentValue("--task-id") ?? DEFAULT_TASK_ID, timestamp, includeHidden, skipFauxAgent, conditionId, agentMode, traceEnabled, repetitionIndex);
		if (!result.allPassed) process.exitCode = 1;
		return;
	}
	if (agentMode !== "faux-text") {
		throw new Error("--all-tasks is only allowed with --agent-mode=faux-text to avoid accidental multi-task real-model spend");
	}

	const continueOnTaskFailure = hasFlag("--continue-on-task-failure");
	const suiteDir = join(RUNS_ROOT, timestamp);
	await mkdir(suiteDir, { recursive: true });
	const taskResults: SuiteTaskResult[] = [];
	let hasFailure = false;
	for (const taskId of await discoverTaskIds(MEMSWE_ROOT)) {
		try {
			const result = await runTask(taskId, timestamp, includeHidden, skipFauxAgent, conditionId, agentMode, traceEnabled, repetitionIndex);
			const status = result.allPassed ? "passed" : "failed";
			hasFailure = hasFailure || !result.allPassed;
			taskResults.push({
				task_id: taskId,
				status,
				run_record: result.runRecordPath,
				failed_phase: result.allPassed ? null : "verification",
				error: null,
			});
			if (!result.allPassed && !continueOnTaskFailure) break;
		} catch (caught) {
			hasFailure = true;
			taskResults.push({
				task_id: taskId,
				status: "failed",
				run_record: null,
				failed_phase: "harness",
				error: caught instanceof Error ? caught.message : String(caught),
			});
			if (!continueOnTaskFailure) break;
		}
	}

	const summary = {
		schema_version: "memswe-suite-summary.v0.1",
		created_at: new Date().toISOString(),
		task_results: taskResults,
	};
	const suiteSummaryPath = join(suiteDir, "suite-summary.json");
	await writeFile(suiteSummaryPath, `${JSON.stringify(summary, null, "	")}\n`);
	console.log(`Wrote ${relative(REPO_ROOT, suiteSummaryPath)}`);
	if (hasFailure) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
