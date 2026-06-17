#!/usr/bin/env -S npx tsx

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const SCRIPT_DIR = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const MEMSWE_ROOT = resolve(REPO_ROOT, "../memswe");
const RUNS_ROOT = join(REPO_ROOT, ".memswe-runs");
const API_URL = process.env.HINDSIGHT_API_URL ?? "http://127.0.0.1:8888";
const BANK_ID = process.env.HINDSIGHT_BANK_ID ?? "memswe-repo-gamma-local-smoke";
const TASK_ID = "repo-gamma-invoice-export-001";

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

type TaskYaml = {
	harbor?: { metadata?: { task_id?: string } };
	memswe?: {
		session_sequence?: Array<{ session_id?: string; graded?: boolean }>;
		facts?: { introduce?: FactSpec[] };
	};
};

type FactSpec = {
	id?: string;
	text?: string;
	first_valid_session?: string;
	invalid_after_session?: string;
	forget_requested_session?: string;
	expected_use?: string;
};

async function requestJson(method: string, path: string, trace: TraceEvent[], body?: JsonValue): Promise<{ status: number; json: JsonValue }> {
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

async function deleteBankIfPresent(trace: TraceEvent[]): Promise<void> {
	// Hindsight returns success with deleted_count=0 for missing banks. Any HTTP/network
	// failure here means reset did not complete; fail closed instead of risking a dirty bank.
	await requestJson("DELETE", `/v1/default/banks/${BANK_ID}`, trace);
}

async function pollUntil(trace: TraceEvent[], label: string, predicate: (json: JsonValue) => boolean): Promise<JsonValue> {
	const deadline = Date.now() + 60_000;
	let last: JsonValue = null;
	while (Date.now() < deadline) {
		const response = await requestJson("GET", `/v1/default/banks/${BANK_ID}/memories/list?limit=100`, trace);
		last = response.json;
		if (predicate(response.json)) return response.json;
		await new Promise((resolvePoll) => setTimeout(resolvePoll, 2_000));
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

function compareSessionIds(left: string | undefined, right: string): number {
	if (!left) return 1;
	return sessionIndex(left) - sessionIndex(right);
}

function sessionIndex(sessionId: string): number {
	const parsed = Number(sessionId.slice(1));
	return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function resolveGradedSessionId(task: TaskYaml): string {
	const graded = task.memswe?.session_sequence?.find((session) => session.graded);
	if (!graded?.session_id) throw new Error(`Task ${TASK_ID} does not declare a graded session`);
	return graded.session_id;
}

function validFactsBeforeSession(task: TaskYaml, sessionId: string): FactSpec[] {
	return (task.memswe?.facts?.introduce ?? []).filter((fact) => {
		if (!fact.id || !fact.text || fact.expected_use === "forbidden") return false;
		if (compareSessionIds(fact.first_valid_session, sessionId) > 0) return false;
		if (compareSessionIds(fact.invalid_after_session, sessionId) <= 0) return false;
		if (compareSessionIds(fact.forget_requested_session, sessionId) <= 0) return false;
		return true;
	});
}

async function loadTaskFacts(): Promise<FactSpec[]> {
	const taskPath = join(MEMSWE_ROOT, "tasks", TASK_ID, "task.yaml");
	const task = parse(await readFile(taskPath, "utf8")) as TaskYaml;
	const taskId = task.harbor?.metadata?.task_id;
	if (taskId !== TASK_ID) throw new Error(`Loaded unexpected task ${taskId ?? "<missing>"} from ${taskPath}`);
	return validFactsBeforeSession(task, resolveGradedSessionId(task));
}

async function runSmoke(trace: TraceEvent[], predicateResults: Record<string, boolean>): Promise<SmokeResult> {
	const facts = await loadTaskFacts();
	await requestJson("GET", "/health", trace);
	await deleteBankIfPresent(trace);
	await requestJson("PUT", `/v1/default/banks/${BANK_ID}`, trace, {
		name: "MemSWE repo gamma local smoke",
		retain_mission: "Retain only durable MemSWE task facts and codebase preferences.",
		reflect_mission: "Recall MemSWE task facts for benchmark harness validation.",
	});
	await requestJson("POST", `/v1/default/banks/${BANK_ID}/memories`, trace, {
		async: false,
		items: facts.map((fact) => ({
			content: fact.text!,
			context: `MemSWE ${TASK_ID} seeded fact ${fact.id}; first_valid_session=${fact.first_valid_session ?? "unknown"}`,
			document_id: `memswe-${TASK_ID}-${fact.id}`,
			tags: ["memswe", TASK_ID, fact.id!],
			metadata: {
				task_id: TASK_ID,
				fact_id: fact.id!,
				first_valid_session: fact.first_valid_session ?? null,
				invalid_after_session: fact.invalid_after_session ?? null,
				forget_requested_session: fact.forget_requested_session ?? null,
				expected_use: fact.expected_use ?? null,
			},
		})),
	});
	const listed = await pollUntil(trace, "retained gamma header fact", (json) =>
		memoryTexts(json).some((text) => text.includes("invoice_id") || text.includes("customer_id")),
	);
	predicateResults.retain_visible = memoryTexts(listed).length > 0;
	const recall = await requestJson("POST", `/v1/default/banks/${BANK_ID}/memories/recall`, trace, {
		query: "What is the current gamma invoice CSV export header, sort order, and public endpoint requirement?",
		budget: "mid",
		max_tokens: 1024,
		trace: true,
		tags: ["memswe", TASK_ID],
		tags_match: "all_strict",
	});
	const recallJson = JSON.stringify(recall.json);
	predicateResults.recall_mentions_gamma_fact = recallJson.includes("invoice") && recallJson.includes("created_at") && recallJson.includes("endpoint");
	await requestJson("DELETE", `/v1/default/banks/${BANK_ID}/memories`, trace);
	const afterDelete = await pollUntil(trace, "deleted memories", (json) => memoryTexts(json).length === 0);
	predicateResults.delete_cleared_bank = memoryTexts(afterDelete).length === 0;
	await deleteBankIfPresent(trace);
	const passed = Object.values(predicateResults).every(Boolean);
	return {
		schema_version: "memswe-hindsight-smoke.v0.1",
		created_at: new Date().toISOString(),
		api_url: API_URL,
		bank_id: BANK_ID,
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
	const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	const artifactsDir = join(RUNS_ROOT, timestamp, "hindsight-local-smoke");
	const trace: TraceEvent[] = [];
	const predicateResults: Record<string, boolean> = {};
	await mkdir(artifactsDir, { recursive: true });
	try {
		const result = await runSmoke(trace, predicateResults);
		await writeFile(join(artifactsDir, "hindsight-smoke-result.json"), `${JSON.stringify(result, null, "\t")}\n`);
		console.log(`Wrote ${relative(REPO_ROOT, join(artifactsDir, "hindsight-smoke-result.json"))}`);
		if (result.status !== "passed") process.exitCode = 1;
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		const phase = failedPhase(trace);
		const result: SmokeResult = {
			schema_version: "memswe-hindsight-smoke.v0.1",
			created_at: new Date().toISOString(),
			api_url: API_URL,
			bank_id: BANK_ID,
			status: "failed",
			trace,
			predicate_results: predicateResults,
			error: {
				failed_phase: phase,
				message,
				guidance: failureGuidance(message, phase),
			},
		};
		await writeFile(join(artifactsDir, "hindsight-smoke-result.json"), `${JSON.stringify(result, null, "\t")}\n`);
		console.error(`Hindsight smoke failed: ${message}`);
		console.error(result.error.guidance);
		console.log(`Wrote ${relative(REPO_ROOT, join(artifactsDir, "hindsight-smoke-result.json"))}`);
		process.exitCode = 1;
	}
}

await main();
