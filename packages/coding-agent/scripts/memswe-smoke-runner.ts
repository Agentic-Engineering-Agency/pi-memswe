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
	SessionSpec,
	VerifierSpec,
	discoverTaskIds,
	inferVerifierAssets,
	initializeWorktreeBaseline,
	preparePythonEnvironment,
	scrubSecretEnv,
	type TaskYaml,
	validateRunRecordAgainstSchema,
	validateRunRecordShape,
	validFactsBeforeSession,
	writePatchArtifacts,
} from "./memswe-smoke-runner-lib.ts";
import { createMemSweTrace, isMemSweOtlpExportConfigured, memoryLatencySummary, traceCompletenessSummary } from "./memswe-trace-scaffold.ts";

const DEFAULT_TASK_ID = "repo-gamma-invoice-export-001";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const MEMSWE_ROOT = resolve(REPO_ROOT, "../memswe");
const RUNS_ROOT = join(REPO_ROOT, ".memswe-runs");
const MEMORY_CONDITION_IDS = ["no_memory", "full_context", "repository_docs", "hindsight"] as const;
const AGENT_MODE_IDS = ["faux-text", "minimax-real", "omniroute-free", "openrouter-free"] as const;
const DEFAULT_HINDSIGHT_API_URL = "http://hindsight-server:8888";
const DEFAULT_HINDSIGHT_BANK_PREFIX = "pap-membench-run";

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
	changedFiles?: number;
	toolCalls?: unknown[];
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
	metric_overrides?: Record<string, number | null | Record<string, number>>;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type HindsightTraceEvent = {
	name: string;
	method: string;
	path: string;
	status: number | null;
	latency_ms: number;
	request?: JsonValue;
	response?: JsonValue;
	error?: string;
};

type HindsightConditionArtifact = {
	schema_version: "memswe-hindsight-condition.v0.1";
	created_at: string;
	api_url: string;
	bank_id: string;
	status: "passed" | "failed";
	seeded_fact_count: number;
	recalled_memory_count: number;
	injected_memory_path: string;
	trace: HindsightTraceEvent[];
	predicate_results: Record<string, boolean>;
	error?: {
		failed_phase: string;
		message: string;
		guidance: string;
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

function parseConditionId(value: string | undefined): MemoryConditionId {
	const conditionId = value ?? "no_memory";
	if (MEMORY_CONDITION_IDS.includes(conditionId as MemoryConditionId)) return conditionId as MemoryConditionId;
	throw new Error(`Invalid --condition=${conditionId}; expected one of ${MEMORY_CONDITION_IDS.join(", ")}`);
}

function parseAgentMode(value: string | undefined): AgentMode {
	const agentMode = value ?? "faux-text";
	if (AGENT_MODE_IDS.includes(agentMode as AgentMode)) return agentMode as AgentMode;
	throw new Error(`Invalid --agent-mode=${agentMode}; expected one of ${AGENT_MODE_IDS.join(", ")}`);
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

async function runFauxAgentSession(task: TaskYaml, taskDir: string, workdir: string, artifactsDir: string): Promise<AgentRunResult> {
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

async function runMinimaxAgentSession(task: TaskYaml, taskDir: string, workdir: string, artifactsDir: string): Promise<AgentRunResult> {
	const gradedSession = resolveGradedSession(task);
	const prompt = await readFile(join(taskDir, gradedSession.prompt_ref!), "utf8");
	if (process.env.MEMSWE_ALLOW_REAL_MODEL !== "1") {
		throw new Error("--agent-mode=minimax-real requires MEMSWE_ALLOW_REAL_MODEL=1 to confirm intentional real-model spend.");
	}
	const apiKey = process.env.MINIMAX_API_KEY ?? process.env.HINDSIGHT_API_LLM_API_KEY;
	if (!apiKey) {
		throw new Error("--agent-mode=minimax-real requires MINIMAX_API_KEY in the environment; HINDSIGHT_API_LLM_API_KEY is accepted for local smoke reuse.");
	}

	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("minimax", apiKey);
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const model = modelRegistry.find("minimax", "MiniMax-M3");
	if (!model) throw new Error("MiniMax-M3 model is not registered for provider minimax");

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
		agent_mode: "minimax-real",
		model_id: model.id,
		provider_id: model.provider,
		base_url: model.baseUrl,
	};
}

async function runOmnirouteAgentSession(task: TaskYaml, taskDir: string, workdir: string, artifactsDir: string): Promise<AgentRunResult> {
	const gradedSession = resolveGradedSession(task);
	const prompt = await readFile(join(taskDir, gradedSession.prompt_ref!), "utf8");
	if (process.env.MEMSWE_ALLOW_REAL_MODEL !== "1") {
		throw new Error("--agent-mode=omniroute-free requires MEMSWE_ALLOW_REAL_MODEL=1 to confirm intentional real-model spend.");
	}
	const apiKey = process.env.OMNIROUTE_API_KEY;
	if (!apiKey) {
		throw new Error("--agent-mode=omniroute-free requires OMNIROUTE_API_KEY in the environment.");
	}
	const baseUrl = process.env.OMNIROUTE_BASE_URL ?? "https://omniroute.agenticengineering.lat/v1";
	const model = process.env.OMNIROUTE_MODEL;
	if (!model) {
		throw new Error("OMNIROUTE_MODEL env required (no auto/free model in gateway catalog).");
	}

	let status: AgentRunResult["status"] = "completed";
	let error: string | null = null;
	let finalResponse = "";
	const events: unknown[] = [];
	const messages: Array<{ role: string; content: string }> = [{ role: "user", content: prompt }];
	try {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ model, messages, tools: [] }),
		});
		if (!response.ok) {
			throw new Error(`omniroute chat completions request failed with ${response.status}: ${await response.text()}`);
		}
		const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
		finalResponse = body.choices?.[0]?.message?.content ?? "";
		messages.push({ role: "assistant", content: finalResponse });
	} catch (caught) {
		status = "errored";
		error = caught instanceof Error ? caught.message : String(caught);
	} finally {
		await writeFile(join(artifactsDir, "agent-events.json"), `${JSON.stringify(toJsonSafe(events), null, "	")}\n`);
		await writeFile(join(artifactsDir, "agent-messages.json"), `${JSON.stringify(toJsonSafe(messages), null, "	")}\n`);
	}

	await writeFile(join(artifactsDir, "agent-final-response.txt"), `${finalResponse}\n`);
	return {
		session_id: gradedSession.session_id!,
		prompt_ref: gradedSession.prompt_ref!,
		final_response: finalResponse,
		event_count: events.length,
		message_count: messages.length,
		status,
		error,
		agent_mode: "omniroute-free",
		model_id: model,
		provider_id: "omniroute",
		base_url: baseUrl,
		changedFiles: 0,
		toolCalls: [],
	};
}

async function runOpenRouterAgentSession(task: TaskYaml, taskDir: string, workdir: string, artifactsDir: string): Promise<AgentRunResult> {
	const gradedSession = resolveGradedSession(task);
	const prompt = await readFile(join(taskDir, gradedSession.prompt_ref!), "utf8");
	if (process.env.MEMSWE_ALLOW_REAL_MODEL !== "1") {
		throw new Error("--agent-mode=openrouter-free requires MEMSWE_ALLOW_REAL_MODEL=1 to confirm intentional real-model spend.");
	}
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		throw new Error("--agent-mode=openrouter-free requires OPENROUTER_API_KEY in the environment.");
	}
	const baseUrl = "https://openrouter.ai/api/v1";
	const model = process.env.OPENROUTER_MODEL;
	if (!model) {
		throw new Error("OPENROUTER_MODEL env required (no auto/free model in OpenRouter catalog).");
	}

	let status: AgentRunResult["status"] = "completed";
	let error: string | null = null;
	let finalResponse = "";
	const events: unknown[] = [];
	const messages: Array<{ role: string; content: string }> = [{ role: "user", content: prompt }];
	try {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ model, messages, tools: [] }),
		});
		if (!response.ok) {
			throw new Error(`openrouter chat completions request failed with ${response.status}: ${await response.text()}`);
		}
		const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
		finalResponse = body.choices?.[0]?.message?.content ?? "";
		messages.push({ role: "assistant", content: finalResponse });
	} catch (caught) {
		status = "errored";
		error = caught instanceof Error ? caught.message : String(caught);
	} finally {
		await writeFile(join(artifactsDir, "agent-events.json"), `${JSON.stringify(toJsonSafe(events), null, "	")}\n`);
		await writeFile(join(artifactsDir, "agent-messages.json"), `${JSON.stringify(toJsonSafe(messages), null, "	")}\n`);
	}

	await writeFile(join(artifactsDir, "agent-final-response.txt"), `${finalResponse}\n`);
	return {
		session_id: gradedSession.session_id!,
		prompt_ref: gradedSession.prompt_ref!,
		final_response: finalResponse,
		event_count: events.length,
		message_count: messages.length,
		status,
		error,
		agent_mode: "openrouter-free",
		model_id: model,
		provider_id: "openrouter",
		base_url: baseUrl,
		changedFiles: 0,
		toolCalls: [],
	};
}

async function runAgentSession(agentMode: AgentMode, task: TaskYaml, taskDir: string, workdir: string, artifactsDir: string): Promise<AgentRunResult> {
	if (agentMode === "minimax-real") return runMinimaxAgentSession(task, taskDir, workdir, artifactsDir);
	if (agentMode === "omniroute-free") return runOmnirouteAgentSession(task, taskDir, workdir, artifactsDir);
	if (agentMode === "openrouter-free") return runOpenRouterAgentSession(task, taskDir, workdir, artifactsDir);
	return runFauxAgentSession(task, taskDir, workdir, artifactsDir);
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

function sanitizedIdentifier(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

function hindsightHeaders(hasBody: boolean): Record<string, string> {
	const headers: Record<string, string> = {};
	if (hasBody) headers["content-type"] = "application/json";
	const apiKey = process.env.HINDSIGHT_API_KEY;
	if (apiKey) headers["x-api-key"] = apiKey;
	const bearer = process.env.HINDSIGHT_AUTH_TOKEN ?? process.env.HINDSIGHT_BEARER_TOKEN;
	if (bearer) headers.authorization = `Bearer ${bearer}`;
	return headers;
}

async function requestHindsightJson(
	apiUrl: string,
	method: string,
	path: string,
	trace: HindsightTraceEvent[],
	body?: JsonValue,
): Promise<{ status: number; json: JsonValue }> {
	const started = Date.now();
	const event: HindsightTraceEvent = { name: path, method, path, status: null, latency_ms: 0, request: body };
	try {
		const response = await fetch(`${apiUrl}${path}`, {
			method,
			headers: hindsightHeaders(body !== undefined),
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		let json: JsonValue = null;
		if (text.length > 0) {
			try {
				json = JSON.parse(text) as JsonValue;
			} catch {
				json = { raw_text: text };
			}
		}
		event.status = response.status;
		event.response = json;
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
		return { status: response.status, json };
	} catch (caught) {
		event.error = caught instanceof Error ? caught.message : String(caught);
		throw caught;
	} finally {
		event.latency_ms = Date.now() - started;
		trace.push(event);
	}
}

function memoryTexts(json: JsonValue): string[] {
	if (!json || typeof json !== "object") return [];
	if (Array.isArray(json)) return json.flatMap((item) => memoryTexts(item));
	const direct = ["text", "content", "memory"].flatMap((key) => {
		const value = json[key];
		return typeof value === "string" ? [value] : [];
	});
	const nested = ["items", "memories", "results", "data"].flatMap((key) => memoryTexts(json[key] ?? null));
	return [...direct, ...nested].filter((text) => text.length > 0);
}

async function pollHindsightUntil(
	apiUrl: string,
	trace: HindsightTraceEvent[],
	bankId: string,
	label: string,
	predicate: (json: JsonValue) => boolean,
): Promise<JsonValue> {
	const deadline = Date.now() + 60_000;
	let last: JsonValue = null;
	while (Date.now() < deadline) {
		const response = await requestHindsightJson(apiUrl, "GET", `/v1/default/banks/${bankId}/memories/list?limit=100`, trace);
		last = response.json;
		if (predicate(response.json)) return response.json;
		await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, 2_000));
	}
	throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

function factMetadata(taskId: string, fact: { id?: string; first_valid_session?: string; invalid_after_session?: string; forget_requested_session?: string; expected_use?: string }): Record<string, string> {
	const metadata: Record<string, string> = {
		task_id: taskId,
		fact_id: fact.id ?? "unknown",
		scope: "memswe-hindsight-condition",
	};
	for (const key of ["first_valid_session", "invalid_after_session", "forget_requested_session", "expected_use"] as const) {
		const value = fact[key];
		if (value) metadata[key] = value;
	}
	return metadata;
}

function hindsightFailureGuidance(message: string, failedPhase: string): string {
	if (message === "fetch failed") {
		return "Verify HINDSIGHT_API_URL points at a reachable Hindsight API before rerunning.";
	}
	if (failedPhase.includes("/memories")) {
		return "Retain/recall reached Hindsight but failed. Verify the scoped API key and any configured Hindsight LLM provider/cost approval before rerunning.";
	}
	if (failedPhase.includes("/banks/")) {
		return "Bank reset/create/delete did not complete. Fail closed and inspect Hindsight state before rerunning to avoid dirty-bank leakage.";
	}
	return "Inspect the Hindsight condition trace before rerunning; do not promote this artifact as benchmark-result evidence.";
}

function failedHindsightPhase(trace: HindsightTraceEvent[]): string {
	const lastError = [...trace].reverse().find((event) => event.error);
	if (lastError) return `${lastError.method} ${lastError.path}`;
	const last = trace.at(-1);
	return last ? `${last.method} ${last.path}` : "preflight";
}

function hindsightRecallMarkdown(taskId: string, bankId: string, recalledTexts: string[]): string {
	return `${[
		"# Hindsight Retrieved Memory",
		"",
		`Task: ${taskId}`,
		"Condition: hindsight",
		`Bank: ${bankId}`,
		"",
		"These facts were retrieved from the scoped Hindsight bank before the graded session prompt.",
		"",
		"## Recalled facts",
		"",
		...(recalledTexts.length === 0 ? ["- <no recalled facts>"] : recalledTexts.map((text) => `- ${text}`)),
	].join("\n")}\n`;
}

async function prepareHindsightCondition(task: TaskYaml, workdir: string, artifactsDir: string, runId: string): Promise<ConditionPrepareResult> {
	const conditionResultPath = join(artifactsDir, "condition-result.json");
	const conditionArtifactPath = join(artifactsDir, "hindsight-condition.json");
	const injectedMemoryPath = join(workdir, "docs/agent-project-memory/hindsight-recall.md");
	const injectedMemoryArtifactPath = join(artifactsDir, "hindsight-recall.md");
	const trace: HindsightTraceEvent[] = [];
	const predicateResults: Record<string, boolean> = {};
	const taskId = task.harbor?.metadata?.task_id ?? DEFAULT_TASK_ID;
	const gradedSession = resolveGradedSession(task);
	const facts = validFactsBeforeSession(task, gradedSession.session_id!);
	const apiUrl = (process.env.HINDSIGHT_API_URL ?? DEFAULT_HINDSIGHT_API_URL).replace(/\/+$/, "");
	const bankPrefix = sanitizedIdentifier(process.env.HINDSIGHT_BANK_PREFIX ?? DEFAULT_HINDSIGHT_BANK_PREFIX);
	const bankId = sanitizedIdentifier(process.env.HINDSIGHT_BANK_ID ?? `${bankPrefix}-${taskId}-${runId}`);
	const started = Date.now();
	let artifact: HindsightConditionArtifact;

	try {
		await requestHindsightJson(apiUrl, "GET", "/health", trace);
		await requestHindsightJson(apiUrl, "DELETE", `/v1/default/banks/${bankId}`, trace);
		await requestHindsightJson(apiUrl, "PUT", `/v1/default/banks/${bankId}`, trace, {
			name: `MemSWE ${taskId} Hindsight condition canary`,
			retain_mission: "Retain only durable MemSWE task facts that are valid before the graded session.",
			reflect_mission: "Recall MemSWE task facts for benchmark harness validation.",
		});
		await requestHindsightJson(apiUrl, "POST", `/v1/default/banks/${bankId}/memories`, trace, {
			async: false,
			items: facts.map((fact) => ({
				content: fact.text ?? "",
				context: `MemSWE ${taskId} seeded fact ${fact.id ?? "unknown"} before session ${gradedSession.session_id}`,
				document_id: `memswe-${taskId}-${fact.id ?? "unknown"}`,
				tags: ["memswe", taskId, fact.id ?? "unknown"],
				metadata: factMetadata(taskId, fact),
			})),
		});
		const listed = await pollHindsightUntil(
			apiUrl,
			trace,
			bankId,
			"seeded valid facts",
			(json) => memoryTexts(json).length >= facts.filter((fact) => fact.text).length,
		);
		const listedTexts = memoryTexts(listed);
		predicateResults.retain_visible = listedTexts.length > 0;
		const recall = await requestHindsightJson(apiUrl, "POST", `/v1/default/banks/${bankId}/memories/recall`, trace, {
			query: "What durable task facts are relevant to the gamma invoice CSV export implementation?",
			budget: "mid",
			max_tokens: 1024,
			trace: true,
			tags: ["memswe", taskId],
			tags_match: "all_strict",
		});
		const recalledTexts = memoryTexts(recall.json);
		predicateResults.recall_returned_memory = recalledTexts.length > 0;
		const markdown = hindsightRecallMarkdown(taskId, bankId, recalledTexts.length > 0 ? recalledTexts : listedTexts);
		await mkdir(dirname(injectedMemoryPath), { recursive: true });
		await mkdir(dirname(injectedMemoryArtifactPath), { recursive: true });
		await writeFile(injectedMemoryPath, markdown);
		await writeFile(injectedMemoryArtifactPath, markdown);
		await requestHindsightJson(apiUrl, "DELETE", `/v1/default/banks/${bankId}/memories`, trace);
		const afterDelete = await pollHindsightUntil(apiUrl, trace, bankId, "deleted memories", (json) => memoryTexts(json).length === 0);
		predicateResults.delete_cleared_bank = memoryTexts(afterDelete).length === 0;
		await requestHindsightJson(apiUrl, "DELETE", `/v1/default/banks/${bankId}`, trace);

		artifact = {
			schema_version: "memswe-hindsight-condition.v0.1",
			created_at: new Date().toISOString(),
			api_url: apiUrl,
			bank_id: bankId,
			status: Object.values(predicateResults).every(Boolean) ? "passed" : "failed",
			seeded_fact_count: facts.filter((fact) => fact.text).length,
			recalled_memory_count: recalledTexts.length,
			injected_memory_path: injectedMemoryArtifactPath,
			trace,
			predicate_results: predicateResults,
		};
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		const phase = failedHindsightPhase(trace);
		artifact = {
			schema_version: "memswe-hindsight-condition.v0.1",
			created_at: new Date().toISOString(),
			api_url: apiUrl,
			bank_id: bankId,
			status: "failed",
			seeded_fact_count: facts.filter((fact) => fact.text).length,
			recalled_memory_count: 0,
			injected_memory_path: injectedMemoryArtifactPath,
			trace,
			predicate_results: predicateResults,
			error: {
				failed_phase: phase,
				message,
				guidance: hindsightFailureGuidance(message, phase),
			},
		};
		await writeFile(conditionArtifactPath, `${JSON.stringify(artifact, null, "	")}\n`);
		throw new Error(`Hindsight condition preparation failed at ${phase}: ${message}`);
	}

	await writeFile(conditionArtifactPath, `${JSON.stringify(artifact, null, "	")}\n`);
	if (artifact.status !== "passed") {
		throw new Error(`Hindsight condition predicates did not pass: ${JSON.stringify(artifact.predicate_results)}`);
	}
	const result: ConditionPrepareResult = {
		condition_id: "hindsight",
		memory_system: "hindsight",
		artifact_paths: {
			condition_result: conditionResultPath,
			hindsight_condition: conditionArtifactPath,
			hindsight_recall: injectedMemoryArtifactPath,
		},
		metric_overrides: {
			memory_retrieval_latency_p50_ms: trace.filter((event) => event.path.includes("/recall")).at(0)?.latency_ms ?? null,
			memory_retrieval_latency_p95_ms: trace.filter((event) => event.path.includes("/recall")).at(0)?.latency_ms ?? null,
			memory_consolidation_settle_time_ms: Date.now() - started,
			memory_operation_tool_calls_by_type: {
				retain: trace.filter((event) => event.method === "POST" && event.path.endsWith("/memories")).length,
				recall: trace.filter((event) => event.path.includes("/recall")).length,
				delete: trace.filter((event) => event.method === "DELETE").length,
				list: trace.filter((event) => event.method === "GET" && event.path.includes("/memories/list")).length,
			},
			injected_memory_tokens: Math.ceil((await readFile(injectedMemoryArtifactPath, "utf8")).split(/\s+/).filter(Boolean).length * 1.3),
		},
	};
	await writeFile(conditionResultPath, `${JSON.stringify(result, null, "	")}\n`);
	return result;
}

async function prepareCondition(conditionId: MemoryConditionId, task: TaskYaml, workdir: string, artifactsDir: string, runId: string): Promise<ConditionPrepareResult> {
	if (conditionId === "hindsight") {
		return prepareHindsightCondition(task, workdir, artifactsDir, runId);
	}
	if (conditionId !== "no_memory" && conditionId !== "repository_docs") {
		throw new Error(`Memory condition ${conditionId} is not implemented`);
	}
	const conditionResultPath = join(artifactsDir, "condition-result.json");
	const artifactPaths: Record<string, string> = { condition_result: conditionResultPath };
	if (conditionId === "repository_docs") {
		const docsPath = join(workdir, "docs/agent-project-memory/memswe-facts.md");
		const docsArtifactPath = join(artifactsDir, "repository-docs/memswe-facts.md");
		const docs = repositoryDocsMarkdown(task);
		await mkdir(dirname(docsPath), { recursive: true });
		await mkdir(dirname(docsArtifactPath), { recursive: true });
		await writeFile(docsPath, docs);
		await writeFile(docsArtifactPath, docs);
		artifactPaths.repository_docs = docsArtifactPath;
	}
	const result: ConditionPrepareResult = {
		condition_id: conditionId,
		memory_system: null,
		artifact_paths: artifactPaths,
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
): Promise<TaskRunResult> {
	const taskDir = join(MEMSWE_ROOT, "tasks", taskId);
	const taskYamlPath = join(taskDir, "task.yaml");
	const parsed = parse(await readFile(taskYamlPath, "utf8"));
	if (!isTaskYaml(parsed)) throw new Error(`Expected object task YAML at ${taskYamlPath}`);

	const runId = `memswe-smoke-${taskId}-${timestamp}`;
	const trace = createMemSweTrace(runId, traceEnabled);
	const benchmarkSpan = trace.startSpan("benchmark", "benchmark.run", { task_id: taskId, condition_id: conditionId, agent_mode: agentMode });
	const artifactsDir = join(RUNS_ROOT, timestamp, taskId);
	const workdir = join(tmpdir(), runId, "worktree");
	const repoDir = join(workdir, "fixture");
	await rm(dirname(workdir), { recursive: true, force: true });
	await mkdir(workdir, { recursive: true });
	await cp(join(taskDir, "fixture"), repoDir, { recursive: true });
	await copyVerifierFiles(taskDir, workdir, parsed, includeHidden);
	await mkdir(artifactsDir, { recursive: true });
	const memorySpan = trace.startSpan("memory", "memory.prepare", { condition_id: conditionId });
	const conditionResult = await prepareCondition(conditionId, parsed, repoDir, artifactsDir, runId);
	memorySpan.end();
	await initializeWorktreeBaseline(repoDir);

	const agentResult = skipFauxAgent ? undefined : await runAgentSession(agentMode, parsed, taskDir, repoDir, artifactsDir);
	if (agentResult) {
		console.log(
			`${agentResult.agent_mode} agent session ${agentResult.session_id} finished with ${agentResult.status}; captured ${agentResult.event_count} event(s).`,
		);
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
	const allPassed = verifiersPassed && agentPassed;
	scoringSpan.end();
	benchmarkSpan.end();
	const traceArtifact = trace.toArtifact();
	await trace.flush();
	const traceCompleteness = traceCompletenessSummary(traceArtifact);
	const memoryLatency = memoryLatencySummary(traceArtifact);
	const traceArtifactPath = join(artifactsDir, "memswe-trace.json");
	const record: RunRecord = {
		run_id: runId,
		task_id: parsed.harbor?.metadata?.task_id ?? taskId,
		schema_version: "uam-run.v0.1",
		condition: {
			condition_id: conditionResult.condition_id,
			memory_system: conditionResult.memory_system,
			baseline_kind: "verifier_only_smoke",
			model_id: agentResult ? `${agentResult.provider_id}/${agentResult.model_id}` : "none/verifier-only",
			repetition_index: 1,
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
			task_success_visible: visible.length === 0 ? null : passed(visible) / visible.length,
			task_success_hidden: hidden.length === 0 ? null : passed(hidden) / hidden.length,
			per_task_cost_usd: 0,
			end_to_end_task_latency_ms: results.reduce((sum, result) => sum + result.duration_ms, 0),
			memory_retrieval_latency_p50_ms: memoryLatency.p50_ms,
			memory_retrieval_latency_p95_ms: memoryLatency.p95_ms,
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
			trace_coverage: trace.enabled ? traceCompleteness.traceCoverage : null,
			...(conditionId === "hindsight"
				? {
						per_task_cost_usd: null,
						total_tokens: null,
						input_tokens: null,
						output_tokens: null,
						memory_operation_tool_call_share: null,
						injected_memory_token_share: null,
					}
				: {}),
			...(conditionResult.metric_overrides ?? {}),
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
				outcome: trace.enabled ? (traceCompleteness.complete ? "pass" : "fail") : "not_evaluable",
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
	console.log(`Wrote ${relative(REPO_ROOT, runRecordPath)}`);
	return { taskId, allPassed, runRecordPath };
}

async function main(): Promise<void> {
	const includeHidden = hasFlag("--include-hidden");
	const skipFauxAgent = hasFlag("--skip-faux-agent");
	const conditionId = parseConditionId(getArgumentValue("--condition"));
	const agentMode = parseAgentMode(getArgumentValue("--agent-mode"));
	const traceEnabled = !hasFlag("--no-otel-trace") && (hasFlag("--otel-trace") || isMemSweOtlpExportConfigured());
	const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	if (!hasFlag("--all-tasks")) {
		const result = await runTask(getArgumentValue("--task-id") ?? DEFAULT_TASK_ID, timestamp, includeHidden, skipFauxAgent, conditionId, agentMode, traceEnabled);
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
			const result = await runTask(taskId, timestamp, includeHidden, skipFauxAgent, conditionId, agentMode, traceEnabled);
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
