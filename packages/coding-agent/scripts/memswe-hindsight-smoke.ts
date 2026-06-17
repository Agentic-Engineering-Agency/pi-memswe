#!/usr/bin/env -S npx tsx

import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const RUNS_ROOT = join(REPO_ROOT, ".memswe-runs");
const API_URL = process.env.HINDSIGHT_API_URL ?? "http://127.0.0.1:8888";
const BANK_ID = process.env.HINDSIGHT_BANK_ID ?? "memswe-repo-gamma-local-smoke";

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
	try {
		await requestJson("DELETE", `/v1/default/banks/${BANK_ID}`, trace);
	} catch {
		// Reset is best-effort: missing bank or first-run startup races are acceptable before create.
	}
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

async function runSmoke(): Promise<SmokeResult> {
	const trace: TraceEvent[] = [];
	const predicateResults: Record<string, boolean> = {};
	await requestJson("GET", "/health", trace);
	await deleteBankIfPresent(trace);
	await requestJson("PUT", `/v1/default/banks/${BANK_ID}`, trace, {
		name: "MemSWE repo gamma local smoke",
		retain_mission: "Retain only durable MemSWE task facts and codebase preferences.",
		reflect_mission: "Recall MemSWE task facts for benchmark harness validation.",
	});
	await requestJson("POST", `/v1/default/banks/${BANK_ID}/memories`, trace, {
		async: false,
		items: [
			{
				content: "MemSWE gamma invoice export header is invoice_id,customer_id,total_cents,currency.",
				context: "repo-gamma-invoice-export-001 seeded fact",
				document_id: "memswe-gamma-s2-header",
				tags: ["memswe", "repo-gamma-invoice-export-001"],
			},
			{
				content: "MemSWE gamma invoice export rows are sorted by created_at descending.",
				context: "repo-gamma-invoice-export-001 seeded fact",
				document_id: "memswe-gamma-s2-sort",
				tags: ["memswe", "repo-gamma-invoice-export-001"],
			},
		],
	});
	const listed = await pollUntil(trace, "retained gamma header fact", (json) =>
		memoryTexts(json).some((text) => text.includes("invoice_id") || text.includes("customer_id")),
	);
	predicateResults.retain_visible = memoryTexts(listed).length > 0;
	const recall = await requestJson("POST", `/v1/default/banks/${BANK_ID}/memories/recall`, trace, {
		query: "What is the current gamma invoice CSV export header and sort order?",
		budget: "mid",
		max_tokens: 1024,
		trace: true,
		tags: ["memswe", "repo-gamma-invoice-export-001"],
		tags_match: "all_strict",
	});
	predicateResults.recall_mentions_gamma_fact = JSON.stringify(recall.json).includes("invoice") && JSON.stringify(recall.json).includes("created_at");
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

async function main(): Promise<void> {
	const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	const artifactsDir = join(RUNS_ROOT, timestamp, "hindsight-local-smoke");
	await mkdir(artifactsDir, { recursive: true });
	try {
		const result = await runSmoke();
		await writeFile(join(artifactsDir, "hindsight-smoke-result.json"), `${JSON.stringify(result, null, "\t")}\n`);
		console.log(`Wrote ${relative(REPO_ROOT, join(artifactsDir, "hindsight-smoke-result.json"))}`);
		if (result.status !== "passed") process.exitCode = 1;
	} catch (caught) {
		const result: SmokeResult = {
			schema_version: "memswe-hindsight-smoke.v0.1",
			created_at: new Date().toISOString(),
			api_url: API_URL,
			bank_id: BANK_ID,
			status: "failed",
			trace: [],
			predicate_results: {},
		};
		await writeFile(join(artifactsDir, "hindsight-smoke-result.json"), `${JSON.stringify(result, null, "\t")}\n`);
		const message = caught instanceof Error ? caught.message : String(caught);
		console.error(`Hindsight smoke failed: ${message}`);
		if (message === "fetch failed") {
			console.error(`Start local Hindsight first, for example with HINDSIGHT_API_LLM_PROVIDER=minimax and HINDSIGHT_API_LLM_MODEL=MiniMax-M3.`);
		}
		console.log(`Wrote ${relative(REPO_ROOT, join(artifactsDir, "hindsight-smoke-result.json"))}`);
		process.exitCode = 1;
	}
}

await main();
