#!/usr/bin/env -S npx tsx

/// <reference lib="esnext" />
// esnext lib pulls in the Promise.withResolvers type under the repo's ES2022 base tsconfig lib.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { type FactSpec, type TaskYaml, validFactsBeforeSession } from "./memswe-smoke-runner-lib.ts";
import { mintRunScopeId } from "./memswe-adapter-contract.ts";

const SCRIPT_DIR = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const MEMSWE_ROOT = resolve(REPO_ROOT, "../memswe");
const RUNS_ROOT = join(REPO_ROOT, ".memswe-runs");
const API_URL = process.env.HINDSIGHT_API_URL ?? "http://127.0.0.1:8888";
const DEFAULT_TASK_ID = "repo-gamma-invoice-export-001";
function mintBankId(taskId = DEFAULT_TASK_ID, runId?: string): string {
	const runTimestamp = runId ?? new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	return process.env.HINDSIGHT_BANK_ID ?? `memswe-${taskId}-local-smoke-${mintRunScopeId(taskId, runTimestamp)}`;
}
function resolveGradedSession(task: TaskYaml): { session_id?: string; prompt_ref?: string; graded?: boolean } {
	const sessions = task.memswe?.session_sequence ?? [];
	const graded = sessions.find((session) => session.graded);
	const fallback = sessions.at(-1);
	if (!graded && !fallback) throw new Error("Task has no session_sequence entries");
	return graded ?? fallback;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type TraceEvent = {
	name: string;
	method: string;
	path: string;
	status: number | null;
	latency_ms: number;
	request?: JsonValue;
	response?: JsonValue;
	error?: string;
};

type SmokeResult = {
	schema_version: "memswe-hindsight-smoke.v0.1";
	created_at: string;
	api_url: string;
	bank_id: string;
	status: "passed" | "failed";
	trace: TraceEvent[];
	predicate_results: Record<string, boolean>;
	error?: {
		failed_phase: string;
		message: string;
		guidance: string;
	};
};


async function requestJson(method: string, path: string, trace: TraceEvent[], body?: JsonValue, acceptedStatuses: number[] = []): Promise<{ status: number; json: JsonValue }> {
	const started = Date.now();
	const event: TraceEvent = { name: path, method, path, status: null, latency_ms: 0, request: body };
	try {
		const response = await fetch(`${API_URL}${path}`, {
			method,
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		const json = text.length === 0 ? null : (JSON.parse(text) as JsonValue);
		event.status = response.status;
		event.response = json;
		if (!response.ok && !acceptedStatuses.includes(response.status)) throw new Error(`HTTP ${response.status}: ${text}`);
		return { status: response.status, json };
	} catch (caught) {
		event.error = caught instanceof Error ? caught.message : String(caught);
		throw caught;
	} finally {
		event.latency_ms = Date.now() - started;
		trace.push(event);
	}
}

async function deleteBankIfPresent(bankId: string, trace: TraceEvent[]): Promise<void> {
	// A missing bank is already reset. Treat 404 as idempotent success; other HTTP/network
	// failures still fail closed to avoid dirty-bank leakage.
	await requestJson("DELETE", `/v1/default/banks/${bankId}`, trace, undefined, [404]);
}

async function pollUntil(bankId: string, trace: TraceEvent[], label: string, predicate: (json: JsonValue) => boolean): Promise<JsonValue> {
	const deadline = Date.now() + 60_000;
	let last: JsonValue = null;
	while (Date.now() < deadline) {
		const response = await requestJson("GET", `/v1/default/banks/${bankId}/memories/list?limit=100`, trace);
		last = response.json;
		if (predicate(response.json)) return response.json;
		const { promise, resolve: resolvePoll } = Promise.withResolvers<void>();
		setTimeout(resolvePoll, 2_000);
		await promise;
	}
	throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

function memoryTexts(json: JsonValue): string[] {
	if (!json || typeof json !== "object" || Array.isArray(json)) return [];
	const items = json.items;
	if (!Array.isArray(items)) return [];
	return items
		.map((item) => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return "";
			const text = item.text;
			return typeof text === "string" ? text : "";
		})
		.filter((text) => text.length > 0);
}


async function loadTaskFacts(taskId = DEFAULT_TASK_ID): Promise<FactSpec[]> {
	const taskPath = join(MEMSWE_ROOT, "tasks", taskId, "task.yaml");
	const task = parse(await readFile(taskPath, "utf8")) as TaskYaml;
	const loadedTaskId = task.harbor?.metadata?.task_id;
	if (loadedTaskId !== taskId) throw new Error(`Loaded unexpected task ${loadedTaskId ?? "<missing>"} from ${taskPath}`);
	return validFactsBeforeSession(task, resolveGradedSession(task).session_id!);
}

function factMetadata(taskId: string, fact: FactSpec): Record<string, string> {
	const metadata: Record<string, string> = {
		task_id: taskId,
		fact_id: fact.id!,
	};
	for (const key of ["first_valid_session", "invalid_after_session", "forget_requested_session", "expected_use"] as const) {
		const value = fact[key];
		if (value) metadata[key] = value;
	}
	return metadata;
}

function recallQueryForTask(taskId: string, _facts: FactSpec[]): string {
	return `Summarize durable MemSWE memory for task ${taskId}. Include exact configured values, policies, ordering constraints, endpoints, headers, owners, or identifiers if present.`;
}

async function runSmoke(bankId: string, trace: TraceEvent[], predicateResults: Record<string, boolean>, taskId = DEFAULT_TASK_ID): Promise<SmokeResult> {
	const facts = await loadTaskFacts(taskId);
	await requestJson("GET", "/health", trace);
	await deleteBankIfPresent(bankId, trace);
	await requestJson("PUT", `/v1/default/banks/${bankId}`, trace, {
		name: `MemSWE ${taskId} local smoke`,
		retain_mission: "Retain only durable MemSWE task facts and codebase preferences.",
		reflect_mission: "Recall MemSWE task facts for benchmark harness validation.",
	});
	await requestJson("POST", `/v1/default/banks/${bankId}/memories`, trace, {
		async: false,
		items: facts.map((fact) => ({
			content: fact.text!,
			context: `MemSWE ${taskId} seeded fact ${fact.id}; first_valid_session=${fact.first_valid_session ?? "unknown"}`,
			document_id: `memswe-${taskId}-${fact.id}`,
			tags: ["memswe", taskId, fact.id!],
			metadata: factMetadata(taskId, fact),
		})),
	});
	const factTexts = facts.map((fact) => fact.text).filter((text): text is string => typeof text === "string" && text.length > 0);
	const listed = await pollUntil(bankId, trace, `retained ${taskId} facts`, (json) => memoryTexts(json).length >= factTexts.length);
	predicateResults.retain_visible = memoryTexts(listed).length > 0;
	const recall = await requestJson("POST", `/v1/default/banks/${bankId}/memories/recall`, trace, {
		query: recallQueryForTask(taskId, facts),
		budget: "mid",
		max_tokens: 1024,
		trace: true,
		tags: ["memswe", taskId],
		tags_match: "all_strict",
	});
	const recallJson = JSON.stringify(recall.json).toLowerCase();
	predicateResults.recall_returned_task_fact = factTexts.some((text) => text.split(/\W+/).filter((token) => token.length >= 6).some((token) => recallJson.includes(token.toLowerCase())));
	await requestJson("DELETE", `/v1/default/banks/${bankId}/memories`, trace);
	const afterDelete = await pollUntil(bankId, trace, "deleted memories", (json) => memoryTexts(json).length === 0);
	predicateResults.delete_cleared_bank = memoryTexts(afterDelete).length === 0;
	await deleteBankIfPresent(bankId, trace);
	const passed = Object.values(predicateResults).every(Boolean);
	return {
		schema_version: "memswe-hindsight-smoke.v0.1",
		created_at: new Date().toISOString(),
		api_url: API_URL,
		bank_id: bankId,
		status: passed ? "passed" : "failed",
		trace,
		predicate_results: predicateResults,
	};
}

function failureGuidance(message: string, failedPhase: string): string {
	if (message === "fetch failed") {
		return "Start local Hindsight and verify HINDSIGHT_API_URL points at the API, for example http://127.0.0.1:8888.";
	}
	if (failedPhase.includes("/memories")) {
		return "Retain/recall/delete reached the local Hindsight API. Verify the container has a scoped LLM token and model config, e.g. HINDSIGHT_API_LLM_PROVIDER=minimax and HINDSIGHT_API_LLM_MODEL=MiniMax-M3, before rerunning; this path may incur model usage.";
	}
	if (failedPhase.includes("/banks/")) {
		return "Bank reset/create/delete did not complete. Fail closed and inspect local Hindsight state before rerunning to avoid dirty-bank leakage.";
	}
	return "Inspect the trace events in this artifact before rerunning; do not proceed to benchmark pilots without a clean local smoke.";
}

function failedPhase(trace: TraceEvent[]): string {
	const lastError = [...trace].reverse().find((event) => event.error);
	if (lastError) return `${lastError.method} ${lastError.path}`;
	const last = trace.at(-1);
	return last ? `${last.method} ${last.path}` : "preflight";
}

async function main(): Promise<void> {
	const bankId = mintBankId();
	const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	const artifactsDir = join(RUNS_ROOT, timestamp, "hindsight-local-smoke");
	const trace: TraceEvent[] = [];
	const predicateResults: Record<string, boolean> = {};
	await mkdir(artifactsDir, { recursive: true });
	try {
		const result = await runSmoke(bankId, trace, predicateResults);
		await writeFile(join(artifactsDir, "hindsight-smoke-result.json"), `${JSON.stringify(result, null, "\t")}\n`);
		console.log(`Wrote ${relative(REPO_ROOT, join(artifactsDir, "hindsight-smoke-result.json"))}`);
		if (result.status !== "passed") process.exitCode = 1;
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		const phase = failedPhase(trace);
		const error = {
			failed_phase: phase,
			message,
			guidance: failureGuidance(message, phase),
		};
		const result: SmokeResult = {
			schema_version: "memswe-hindsight-smoke.v0.1",
			created_at: new Date().toISOString(),
			api_url: API_URL,
			bank_id: bankId,
			status: "failed",
			trace,
			predicate_results: predicateResults,
			error,
		};
		await writeFile(join(artifactsDir, "hindsight-smoke-result.json"), `${JSON.stringify(result, null, "	")}\n`);
		console.error(`Hindsight smoke failed: ${message}`);
		console.error(error.guidance);
		console.log(`Wrote ${relative(REPO_ROOT, join(artifactsDir, "hindsight-smoke-result.json"))}`);
		process.exitCode = 1;
	}
}

// AGE-195: hindsight provider lifecycle smoke, exported for the graded runner's PROVIDER_LIFECYCLE_SMOKES
// map. Mirrors the cloud-adapter convention: an UNREACHABLE Hindsight server yields status "skipped"
// (not "failed") so the condition wiring is verifiable without the local Hindsight service running, while a
// reachable server that fails a predicate yields "failed". Bank id is minted per call for run isolation.
export async function runHindsightLifecycleSmoke(options: { taskId?: string; runId?: string } = {}): Promise<{
	status: "passed" | "failed" | "skipped";
	predicate_results: Record<string, boolean>;
	export?: SmokeResult;
}> {
	const taskId = options.taskId ?? process.env.MEMSWE_HINDSIGHT_SMOKE_TASK_ID ?? DEFAULT_TASK_ID;
	const bankId = mintBankId(taskId, options.runId);
	const trace: TraceEvent[] = [];
	const predicateResults: Record<string, boolean> = {};
	try {
		const result = await runSmoke(bankId, trace, predicateResults, taskId);
		return { status: result.status, predicate_results: result.predicate_results, export: result };
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		const phase = failedPhase(trace);
		// Server unreachable → skip (matches provider-smoke convention that a missing service is
		// "skipped", not "failed", so the run-record still reflects memory_system = hindsight). A predicate
		// timeout means the server WAS reachable but a predicate failed → that stays "failed".
		const unreachable = message === "fetch failed" || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT/i.test(message);
		const status: "failed" | "skipped" = unreachable ? "skipped" : "failed";
		const result: SmokeResult = {
			schema_version: "memswe-hindsight-smoke.v0.1",
			created_at: new Date().toISOString(),
			api_url: API_URL,
			bank_id: bankId,
			status: "failed",
			trace,
			predicate_results: predicateResults,
			error: { failed_phase: phase, message, guidance: failureGuidance(message, phase) },
		};
		return { status, predicate_results: predicateResults, export: result };
	}
}

// Side-effect-free on import: only run the CLI smoke when executed directly, not when imported by the runner.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
