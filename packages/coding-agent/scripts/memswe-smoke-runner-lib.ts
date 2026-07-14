import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Ajv2020Default, { Ajv2020 as Ajv2020Class, type ErrorObject } from "ajv/dist/2020.js";

const Ajv2020 = Ajv2020Default as unknown as typeof Ajv2020Class;

export type VerifierKind = "visible" | "hidden" | "protected";

export type TaskYaml = {
	schema_version?: string;
	harbor?: {
		metadata?: { task_id?: string };
		verifier?: { timeout_sec?: number };
		environment?: { setup_command?: string };
	};
	memswe?: {
		memory_conditions?: Array<{ id?: string; memory_system?: string }>;
		seeded_history?: SeededHistorySpec[];
		session_sequence?: SessionSpec[];
		facts?: {
			introduce?: FactSpec[];
		};
		verifiers?: {
			visible_tests?: VerifierSpec[];
			hidden_tests?: VerifierSpec[];
			protected_tests?: VerifierSpec[];
		};
		trace_predicates?: Array<{ id?: string; severity?: "blocking" | "diagnostic" }>;
	};
};

export type SeededHistorySpec = {
	id?: string;
	applies_to_conditions?: string[];
	facts?: string[];
	transcript_ref?: string;
};

export type SessionSpec = {
	session_id?: string;
	prompt_ref?: string;
	graded?: boolean;
};

export type FactSpec = {
	id?: string;
	text?: string;
	first_valid_session?: string;
	invalid_after_session?: string;
	forget_requested_session?: string;
	expected_use?: string;
};

export type VerifierSpec = {
	id?: string;
	command?: string;
	agent_visible?: boolean;
	f2p?: boolean;
	p2p?: boolean;
};

export type VerifierAsset = {
	kind: VerifierKind;
	source: string;
	destination: string;
	agentVisible: boolean;
};

export type ShellCommandResult = {
	command: string;
	exit_code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	duration_ms: number;
};

export type PatchArtifacts = {
	agentPatch: string;
	worktreeDiff: string;
	changedFiles: string;
};

type RunRecordLike = {
	schema_version?: unknown;
	run_id?: unknown;
	task_id?: unknown;
	condition?: { condition_id?: unknown };
	session_results?: unknown;
	output_locations?: { artifacts_dir?: unknown };
};

export async function runShellCommand(
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
): Promise<ShellCommandResult> {
	const start = Date.now();
	return new Promise((resolveCommand) => {
		const child = spawn(command, {
			cwd,
			env,
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
				command,
				exit_code: timedOut ? null : code,
				signal,
				stdout,
				stderr: timedOut ? `${stderr}\nTimed out after ${timeoutMs}ms` : stderr,
				duration_ms: Date.now() - start,
			});
		});
	});
}

export const SECRET_ENV_NAME_PATTERN = /(?:secret|token|key|authorization|password|credential|langfuse|otel_exporter)/i;

/**
 * Build a child-process env from process.env with harness secrets removed
 * (any var whose NAME matches SECRET_ENV_NAME_PATTERN — API keys, tokens,
 * Langfuse/OTLP creds). Used for the verifier command AND the task-author
 * setup_command / venv creation so author- or agent-reachable subprocesses
 * never inherit the harness's credentials. Optionally prepends `prependPath`
 * to PATH (e.g. the venv/shim bin dir).
 */
export function scrubSecretEnv(prependPath?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (SECRET_ENV_NAME_PATTERN.test(key)) continue;
		env[key] = value;
	}
	if (prependPath) {
		env.PATH = `${prependPath}:${process.env.PATH ?? ""}`;
	}
	return env;
}

export async function preparePythonEnvironment(
	workdir: string,
	task: TaskYaml,
): Promise<{ shimDir: string; setupResult?: ShellCommandResult }> {
	const setupCommand = task.harbor?.environment?.setup_command;
	if (!requiresPythonEnvironment(task, setupCommand)) {
		return { shimDir: "", setupResult: undefined };
	}

	const venvDir = join(workdir, ".memswe-venv");
	const venvBinDir = join(venvDir, "bin");
	const createVenvResult = await runShellCommand("python3 -m venv .memswe-venv", workdir, scrubSecretEnv(), 120_000);
	if (createVenvResult.exit_code !== 0) {
		throw new Error(`Failed to create verifier virtualenv: ${createVenvResult.stderr || createVenvResult.stdout}`);
	}
	const setupEnv = scrubSecretEnv(venvBinDir);
	const setupResult = setupCommand ? await runShellCommand(setupCommand, workdir, setupEnv, 300_000) : undefined;
	if (setupResult && setupResult.exit_code !== 0) {
		throw new Error(`Verifier setup failed: ${setupResult.stderr || setupResult.stdout}`);
	}
	return { shimDir: venvBinDir, setupResult };
}

function requiresPythonEnvironment(task: TaskYaml, setupCommand: string | undefined): boolean {
	if (setupCommand && /(?:^|\s)(?:python3?|pip3?|pytest)(?:\s|$)/.test(setupCommand)) return true;
	const verifiers = task.memswe?.verifiers;
	for (const spec of [
		...(verifiers?.visible_tests ?? []),
		...(verifiers?.hidden_tests ?? []),
		...(verifiers?.protected_tests ?? []),
	]) {
		if (/(?:^|\s)(?:python3?|pip3?|pytest)(?:\s|$)/.test(spec.command ?? "")) return true;
	}
	return false;
}

export function inferVerifierAssets(taskDir: string, workdir: string, task: TaskYaml, includeHidden: boolean): VerifierAsset[] {
	const verifiers = task.memswe?.verifiers;
	const groups: Array<[VerifierKind, VerifierSpec[] | undefined]> = [
		["visible", verifiers?.visible_tests],
		["protected", verifiers?.protected_tests],
	];
	if (includeHidden) groups.push(["hidden", verifiers?.hidden_tests]);

	const assets = new Map<string, VerifierAsset>();
	for (const [kind, specs] of groups) {
		for (const spec of specs ?? []) {
			for (const verifierPath of verifierPathsFromCommand(spec.command ?? "")) {
				assets.set(`${kind}:${verifierPath}`, {
					kind,
					source: join(taskDir, verifierPath),
					destination: join(workdir, verifierPath),
					agentVisible: kind === "visible" && spec.agent_visible === true,
				});
			}
			for (const verifierDir of verifierDirsFromCommand(spec.command ?? "")) {
				if (!existsSync(join(taskDir, verifierDir))) continue;
				assets.set(`${kind}:${verifierDir}`, {
					kind,
					source: join(taskDir, verifierDir),
					destination: join(workdir, verifierDir),
					agentVisible: false,
				});
			}
		}
	}

	const needsPytestSupport = [...assets.values()].some((asset) => asset.source.endsWith(".py"));
	const conftestPath = "tests/conftest.py";
	if (needsPytestSupport && existsSync(join(taskDir, conftestPath))) {
		assets.set(`protected-support:${conftestPath}`, {
			kind: "protected",
			source: join(taskDir, conftestPath),
			destination: join(workdir, conftestPath),
			agentVisible: false,
		});
	}

	return [...assets.values()];
}

function verifierPathsFromCommand(command: string): string[] {
	return [...command.matchAll(/(?:^|\s)(tests\/[A-Za-z0-9_./-]+\.(?:py|ts|tsx|js|jsx))(?:\:\:[^\s]+)?/g)].map(
		(match) => match[1],
	);
}

function verifierDirsFromCommand(command: string): string[] {
	return [...command.matchAll(/(?:^|[;&|]\s*)cd\s+([A-Za-z0-9_.\/-]+)/g)]
		.map((match) => match[1])
		.filter((dir) => dir === "verifier" || dir.startsWith("verifier/"));
}

export async function initializeWorktreeBaseline(workdir: string): Promise<void> {
	const commands = [
		"git init",
		"git add .",
		"git -c user.name=MemSWE -c user.email=memswe@example.invalid commit -m baseline --no-gpg-sign",
	];
	for (const command of commands) {
		const result = await runShellCommand(command, workdir, process.env, 120_000);
		if (result.exit_code !== 0) {
			throw new Error(`Failed to initialize temp worktree baseline with ${command}: ${result.stderr || result.stdout}`);
		}
	}
}

export async function writePatchArtifacts(workdir: string, artifactsDir: string): Promise<PatchArtifacts> {
	const worktreeDiffPath = join(artifactsDir, "worktree-diff.patch");
	const agentPatchPath = join(artifactsDir, "agent.patch");
	const changedFilesPath = join(artifactsDir, "changed-files.json");
	const diff = await runShellCommand("git diff --binary", workdir, process.env, 120_000);
	if (diff.exit_code !== 0) {
		throw new Error(`Failed to collect worktree diff: ${diff.stderr || diff.stdout}`);
	}
	const tracked = await runShellCommand("git diff --name-only", workdir, process.env, 120_000);
	if (tracked.exit_code !== 0) {
		throw new Error(`Failed to collect changed tracked files: ${tracked.stderr || tracked.stdout}`);
	}
	const untracked = await runShellCommand("git ls-files --others --exclude-standard", workdir, process.env, 120_000);
	if (untracked.exit_code !== 0) {
		throw new Error(`Failed to collect untracked files: ${untracked.stderr || untracked.stdout}`);
	}
	const changedFiles = [...new Set([...tracked.stdout.split("\n"), ...untracked.stdout.split("\n")].filter(Boolean))].sort();
	await writeFile(worktreeDiffPath, diff.stdout);
	await writeFile(agentPatchPath, diff.stdout);
	await writeFile(changedFilesPath, `${JSON.stringify(changedFiles, null, "	")}\n`);
	return { agentPatch: agentPatchPath, worktreeDiff: worktreeDiffPath, changedFiles: changedFilesPath };
}

export function validateRunRecordAgainstSchema(record: unknown, schemaPath: string): void {
	const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const validate = ajv.compile(schema);
	if (!validate(record)) {
		const errors = (validate.errors ?? []).map((error: ErrorObject) => `${error.instancePath || "/"} ${error.message ?? ""}`.trim());
		throw new Error(`Run record violates run-record.schema.json: ${errors.join("; ")}`);
	}
}

export function validateRunRecordShape(record: unknown): void {
	if (!isRunRecordLike(record)) throw new Error("Run record must be an object");
	if (record.schema_version !== "uam-run.v0.1") throw new Error("Invalid run schema_version");
	if (typeof record.run_id !== "string" || record.run_id.length === 0) throw new Error("Missing run_id");
	if (typeof record.task_id !== "string" || record.task_id.length === 0) throw new Error("Missing task_id");
	if (typeof record.condition?.condition_id !== "string" || record.condition.condition_id.length === 0) {
		throw new Error("Missing condition_id");
	}
	if (!Array.isArray(record.session_results) || record.session_results.length === 0) throw new Error("Missing session_results");
	if (typeof record.output_locations?.artifacts_dir !== "string" || record.output_locations.artifacts_dir.length === 0) {
		throw new Error("Missing artifacts_dir");
	}
}

function isRunRecordLike(value: unknown): value is RunRecordLike {
	return typeof value === "object" && value !== null;
}

export async function discoverTaskIds(memsweRoot: string): Promise<string[]> {
	const tasksRoot = join(memsweRoot, "tasks");
	const entries = await readdir(tasksRoot, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isDirectory() && existsSync(join(tasksRoot, entry.name, "task.yaml")))
		.map((entry) => entry.name)
		.sort();
}

export function validFactsBeforeSession(task: TaskYaml, sessionId: string): FactSpec[] {
	return (task.memswe?.facts?.introduce ?? []).filter((fact) => {
		if (!fact.text || fact.expected_use === "forbidden") return false;
		if (fact.first_valid_session && compareSessionIds(fact.first_valid_session, sessionId) >= 0) return false;
		if (compareSessionIds(fact.invalid_after_session, sessionId) < 0) return false;
		if (compareSessionIds(fact.forget_requested_session, sessionId) < 0) return false;
		return true;
	});
}

export function compareSessionIds(left: string | undefined, right: string): number {
	if (!left) return 1;
	return sessionIndex(left) - sessionIndex(right);
}

export function sessionIndex(sessionId: string): number {
	const parsed = Number(sessionId.slice(1));
	return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export type PriorTranscriptMessage = { role: string; content: string };

export type PriorTranscript = {
	source: "seeded_history" | "session";
	id: string;
	messages: PriorTranscriptMessage[];
};

// full_context: assemble every prior (non-graded) turn the agent should carry into the graded
// session — seeded_history transcripts scoped to full_context first, then each prior session's
// prompt as a user turn. Returned in-order; renderFullContextPreamble turns it into prompt text.
export function collectPriorTranscripts(task: TaskYaml, taskDir: string): PriorTranscript[] {
	const transcripts: PriorTranscript[] = [];
	for (const seed of task.memswe?.seeded_history ?? []) {
		const conditions = seed.applies_to_conditions ?? [];
		if (!conditions.includes("full_context")) continue;
		if (!seed.transcript_ref) continue;
		const messages = readTranscriptJsonl(join(taskDir, seed.transcript_ref));
		if (messages.length > 0) transcripts.push({ source: "seeded_history", id: seed.id ?? seed.transcript_ref, messages });
	}
	const sessions = task.memswe?.session_sequence ?? [];
	const gradedIndex = sessions.findIndex((session) => session.graded);
	const priorEnd = gradedIndex === -1 ? sessions.length - 1 : gradedIndex;
	for (let i = 0; i < priorEnd; i++) {
		const session = sessions[i];
		if (!session?.prompt_ref) continue;
		const content = safeReadTextFile(join(taskDir, session.prompt_ref));
		if (content === null) continue;
		transcripts.push({ source: "session", id: session.session_id ?? session.prompt_ref, messages: [{ role: "user", content }] });
	}
	return transcripts;
}

function readTranscriptJsonl(path: string): PriorTranscriptMessage[] {
	if (!existsSync(path)) return [];
	const messages: PriorTranscriptMessage[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as { role?: unknown; content?: unknown };
			const role = typeof parsed.role === "string" ? parsed.role : "assistant";
			const content = typeof parsed.content === "string" ? parsed.content : JSON.stringify(parsed.content ?? "");
			messages.push({ role, content });
		} catch {
			// Skip malformed JSONL lines rather than failing the whole condition.
		}
	}
	return messages;
}

function safeReadTextFile(path: string): string | null {
	if (!existsSync(path)) return null;
	return readFileSync(path, "utf8");
}

// Render collected prior transcripts as a prompt preamble the agent receives before the graded
// prompt. Empty when there is no prior history (single graded session, no seeds).
export function renderFullContextPreamble(transcripts: PriorTranscript[]): string {
	if (transcripts.length === 0) return "";
	const blocks: string[] = [
		"# Prior session history (full_context)",
		"",
		"The following is your complete prior session history for this task. Use it as remembered context when answering the current request.",
	];
	for (const transcript of transcripts) {
		blocks.push("", `## ${transcript.source}:${transcript.id}`);
		for (const message of transcript.messages) {
			blocks.push("", `[${message.role}]`, message.content.trimEnd());
		}
	}
	return `${blocks.join("\n")}\n`;
}

export type ModelPricing = {
	/** USD per 1M input tokens. */
	input: number;
	/** USD per 1M output tokens. */
	output: number;
	/** USD per 1M cached-read tokens. */
	cacheRead: number;
	/** USD per 1M cached-write tokens. */
	cacheWrite: number;
	/** Where the input/output price came from, for logging/diagnostics. */
	source: "environment variables" | "baked default" | "none";
};

/**
 * Default per-model pricing (USD per 1M tokens), keyed by the exact configured model id.
 * Baking a default lets a fresh real run record non-zero per_task_cost_usd without requiring
 * the MEMSWE_LLM_*_COST_PER_M env vars (AGE-204). Only add a key here when you have an
 * authoritative price for that exact model id; unmapped models resolve to 0 (source "none").
 */
export const DEFAULT_MODEL_PRICING: Record<string, { input: number; output: number }> = {
	// DeepSeek-V4-Flash pricing used for corrected AGE-193 rollup/run-records: input 0.14, output 0.28 per 1M tokens.
	"azure/deepseek-v4-flash": { input: 0.14, output: 0.28 },
	"omniroute/azure-ai/DeepSeek-V4-Flash": { input: 0.14, output: 0.28 },
	"azure-ai/DeepSeek-V4-Flash": { input: 0.14, output: 0.28 },
};

/**
 * Resolve the pricing to register for `modelId`. MEMSWE_LLM_*_COST_PER_M env vars take priority;
 * when unset, fall back to the baked default for the model id; when neither applies, price is 0.
 * cacheRead/cacheWrite come only from env (default 0) since baked defaults cover input/output.
 */
export function resolveModelPricing(modelId: string, env: NodeJS.ProcessEnv = process.env): ModelPricing {
	const defaultPricing = DEFAULT_MODEL_PRICING[modelId];
	const envInput = env.MEMSWE_LLM_INPUT_COST_PER_M;
	const envOutput = env.MEMSWE_LLM_OUTPUT_COST_PER_M;
	const envCacheRead = env.MEMSWE_LLM_CACHE_READ_COST_PER_M;
	const envCacheWrite = env.MEMSWE_LLM_CACHE_WRITE_COST_PER_M;

	const rawInput = envInput !== undefined ? Number(envInput) : defaultPricing?.input ?? 0;
	const rawOutput = envOutput !== undefined ? Number(envOutput) : defaultPricing?.output ?? 0;
	const rawCacheRead = envCacheRead !== undefined ? Number(envCacheRead) : 0;
	const rawCacheWrite = envCacheWrite !== undefined ? Number(envCacheWrite) : 0;

	const input = Number.isFinite(rawInput) && rawInput >= 0 ? rawInput : 0;
	const output = Number.isFinite(rawOutput) && rawOutput >= 0 ? rawOutput : 0;
	const cacheRead = Number.isFinite(rawCacheRead) && rawCacheRead >= 0 ? rawCacheRead : 0;
	const cacheWrite = Number.isFinite(rawCacheWrite) && rawCacheWrite >= 0 ? rawCacheWrite : 0;

	const source: ModelPricing["source"] =
		envInput !== undefined || envOutput !== undefined
			? "environment variables"
			: defaultPricing
				? "baked default"
				: "none";

	return { input, output, cacheRead, cacheWrite, source };
}
