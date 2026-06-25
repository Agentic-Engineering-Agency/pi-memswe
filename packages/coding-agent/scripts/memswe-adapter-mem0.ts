#!/usr/bin/env -S npx tsx

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type {
	AdapterExport,
	AdapterRunInput,
	AdapterRunResult,
	AdapterScope,
	AdapterSeedEvent,
	AmsAdapter,
	MemoryOperation,
	NormalizedArtifact,
	NormalizedTrace,
	NormalizedTraceError,
	NormalizedTraceEvent,
} from "./memswe-adapter-contract.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const RUNS_ROOT = join(REPO_ROOT, ".memswe-runs");
const PROVIDER_ID = "mem0";
const DEFAULT_TIMEOUT_MS = 5_000;
// mem0 extracts facts via an LLM during/after add, so a freshly-seeded fact may not be immediately
// searchable; poll for recall (and for the post-delete miss) instead of asserting a single shot.
const DEFAULT_RECALL_TIMEOUT_MS = 20_000;
const DEFAULT_MISS_TIMEOUT_MS = 10_000;
const DEFAULT_RECALL_POLL_MS = 1_000;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type Mem0AdapterOptions = {
	apiUrl: string;
	apiKey?: string;
	timeoutMs?: number;
};

type Mem0RequestOptions = {
	method: string;
	path: string;
	operation: MemoryOperation;
	scope: AdapterScope;
	body?: JsonValue;
};

type Mem0Response = {
	status: number;
	json: JsonValue;
	latencyMs: number;
};

type Mem0SmokeResult = {
	schema_version: "memswe-mem0-smoke.v0.1";
	created_at: string;
	api_url: string | null;
	scope_id: string;
	predicate_results: Record<string, boolean>;
	settle_ms: number | null;
	export: AdapterExport | null;
	error?: {
		failed_phase: string;
		message: string;
		guidance: string;
	};
};

export class Mem0Adapter implements AmsAdapter {
	private readonly apiUrl: string;
	private readonly apiKey?: string;
	private readonly timeoutMs: number;
	private readonly traces: NormalizedTrace[] = [];
	private readonly artifacts: NormalizedArtifact[] = [];

	constructor(options: Mem0AdapterOptions) {
		if (!options.apiUrl) throw new Error("Mem0Adapter requires apiUrl");
		this.apiUrl = options.apiUrl.replace(/\/$/, "");
		this.apiKey = options.apiKey;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async reset(scope: AdapterScope): Promise<NormalizedTrace> {
		const trace = emptyTrace(scope);
		await this.captureRequest(trace, {
			method: "DELETE",
			path: `/memories?${scopeQuery(scope)}`,
			operation: "delete",
			scope,
		});
		return this.recordTrace(trace);
	}

	async seed(events: AdapterSeedEvent[]): Promise<NormalizedTrace> {
		if (events.length === 0) throw new Error("Mem0Adapter.seed requires at least one event");
		const firstScope = events[0]?.scope;
		if (!firstScope) throw new Error("Mem0Adapter.seed requires scoped events");
		const trace = emptyTrace(firstScope);
		for (const event of events) {
			if (event.scope.id !== firstScope.id) throw new Error("Mem0Adapter.seed received mixed scopes");
			const response = await this.captureRequest(trace, {
				method: "POST",
				path: "/memories",
				operation: "write",
				scope: event.scope,
				body: mem0Body({
					messages: [{ role: "user", content: event.content }],
					user_id: event.scope.id,
					agent_id: stringMetadata(event.scope, "agent_id"),
					run_id: runId(event.scope),
					metadata: toJsonObject(event.metadata),
				}),
			});
			const memoryId = firstMemoryId(response.json);
			if (memoryId) trace.events.at(-1)!.memoryId = memoryId;
		}
		return this.recordTrace(trace);
	}

	async run(input: AdapterRunInput): Promise<AdapterRunResult> {
		const trace = emptyTrace(input.scope);
		const response = await this.captureRequest(trace, {
			method: "POST",
			path: "/search",
			operation: "retrieve",
			scope: input.scope,
			body: mem0Body({
				query: input.prompt,
				user_id: input.scope.id,
				agent_id: stringMetadata(input.scope, "agent_id"),
				run_id: runId(input.scope),
				explain: true,
			}),
		});
		const output = JSON.stringify(response.json);
		trace.injectedMemoryTokens = Math.ceil(output.length / 4);
		const lastEvent = trace.events.at(-1);
		if (lastEvent) lastEvent.injectedMemoryTokens = trace.injectedMemoryTokens;
		const recorded = this.recordTrace(trace);
		return { output, trace: recorded };
	}

	async observe(): Promise<NormalizedTrace> {
		const scope = this.lastScope();
		const trace = emptyTrace(scope);
		await this.captureRequest(trace, {
			method: "GET",
			path: `/memories?${scopeQuery(scope)}`,
			operation: "retrieve",
			scope,
		});
		return this.recordTrace(trace);
	}

	async delete(scope: AdapterScope): Promise<NormalizedTrace> {
		const trace = emptyTrace(scope);
		await this.captureRequest(trace, {
			method: "DELETE",
			path: `/memories?${scopeQuery(scope)}`,
			operation: "delete",
			scope,
		});
		return this.recordTrace(trace);
	}

	async export(): Promise<AdapterExport> {
		return {
			providerId: PROVIDER_ID,
			scopeId: this.traces.at(-1)?.scopeId,
			traces: this.traces,
			artifacts: this.artifacts,
		};
	}

	private async captureRequest(trace: NormalizedTrace, options: Mem0RequestOptions): Promise<Mem0Response> {
		const started = Date.now();
		const event: NormalizedTraceEvent = {
			operation: options.operation,
			providerId: PROVIDER_ID,
			scopeId: options.scope.id,
			input: options.body === undefined ? options.path : JSON.stringify(options.body),
			metadata: { method: options.method, path: options.path },
		};
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
			try {
				const response = await fetch(`${this.apiUrl}${options.path}`, {
					method: options.method,
					headers: this.headers(options.body),
					body: options.body === undefined ? undefined : JSON.stringify(options.body),
					signal: controller.signal,
				});
				const text = await response.text();
				const json = text.length === 0 ? null : (JSON.parse(text) as JsonValue);
				event.output = text;
				event.metadata = { ...event.metadata, status: response.status };
				if (!response.ok) throw new Error(`Mem0 ${options.method} ${options.path} failed with HTTP ${response.status}: ${text}`);
				return { status: response.status, json, latencyMs: Date.now() - started };
			} finally {
				clearTimeout(timeout);
			}
		} catch (caught) {
			const error = caught instanceof Error ? caught : new Error(String(caught));
			trace.errors.push({ message: error.message, providerId: PROVIDER_ID, operation: options.operation, code: error.name });
			throw error;
		} finally {
			event.latencyMs = Date.now() - started;
			trace.latencyMs += event.latencyMs;
			trace.events.push(event);
		}
	}

	private headers(body: JsonValue | undefined): HeadersInit {
		const headers: Record<string, string> = {};
		if (body !== undefined) headers["content-type"] = "application/json";
		if (this.apiKey) headers["x-api-key"] = this.apiKey;
		return headers;
	}

	private recordTrace(trace: NormalizedTrace): NormalizedTrace {
		this.traces.push(trace);
		return trace;
	}

	private lastScope(): AdapterScope {
		const lastTrace = this.traces.at(-1);
		if (!lastTrace) throw new Error("Mem0Adapter.observe requires a previous scoped operation");
		return { id: lastTrace.scopeId };
	}
}

export async function runMem0LifecycleSmoke(): Promise<Mem0SmokeResult> {
	const apiUrl = process.env.MEM0_API_URL;
	const scope: AdapterScope = {
		id: `memswe-mem0-smoke-${Date.now()}`,
		metadata: { run_id: "memswe-mem0-lifecycle-smoke", agent_id: "memswe" },
	};
	if (!apiUrl) return skippedSmoke(scope, "MEM0_API_URL is not set");

	const adapter = new Mem0Adapter({
		apiUrl,
		apiKey: process.env.MEM0_API_KEY,
		timeoutMs: Number(process.env.MEM0_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
	});
	const predicates: Record<string, boolean> = {};
	let settleMs: number | null = null;
	try {
		await adapter.reset(scope);
		predicates.reset_completed = true;
		const content = `MemSWE Mem0 smoke fact ${scope.id}: retain recall delete lifecycle marker.`;
		await adapter.seed([{ scope, operation: "write", content, metadata: { smoke: true } }]);
		predicates.retain_completed = true;
		// mem0 fact extraction is asynchronous → poll until the marker is searchable; record settle time.
		const settleStart = Date.now();
		const retained = await waitForRecall(adapter, scope, `Find lifecycle marker for ${scope.id}`, scope.id, "lifecycle marker");
		settleMs = retained ? Date.now() - settleStart : null;
		predicates.recall_after_retain = retained;
		await adapter.observe();
		predicates.observe_completed = true;
		await adapter.delete(scope);
		predicates.delete_completed = true;
		// Reset-safety proof: after the scoped delete the marker must no longer be searchable (poll the miss).
		predicates.recall_miss_after_delete = await waitForMiss(adapter, scope, `Find lifecycle marker for ${scope.id}`, scope.id);
		const exported = await adapter.export();
		return {
			schema_version: "memswe-mem0-smoke.v0.1",
			created_at: new Date().toISOString(),
			api_url: apiUrl,
			scope_id: scope.id,
			status: Object.values(predicates).every(Boolean) ? "passed" : "failed",
			predicate_results: predicates,
			settle_ms: settleMs,
			export: exported,
		};
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		const exported = await adapter.export();
		if (isUnavailable(message)) return skippedSmoke(scope, message, apiUrl, exported);
		return {
			schema_version: "memswe-mem0-smoke.v0.1",
			created_at: new Date().toISOString(),
			api_url: apiUrl,
			scope_id: scope.id,
			status: "failed",
			predicate_results: predicates,
			settle_ms: settleMs,
			export: exported,
			error: {
				failed_phase: failedPhase(exported),
				message,
				guidance: "Mem0 was reachable but lifecycle predicates failed; inspect normalized trace before using this condition in benchmark pilots.",
			},
		};
	}
}

function emptyTrace(scope: AdapterScope): NormalizedTrace {
	return {
		providerId: PROVIDER_ID,
		scopeId: scope.id,
		events: [],
		latencyMs: 0,
		injectedMemoryTokens: 0,
		errors: [],
		artifacts: [],
	};
}

function scopeQuery(scope: AdapterScope): string {
	const params = new URLSearchParams({ user_id: scope.id });
	const agentId = stringMetadata(scope, "agent_id");
	const scopedRunId = runId(scope);
	if (agentId) params.set("agent_id", agentId);
	if (scopedRunId) params.set("run_id", scopedRunId);
	return params.toString();
}

function runId(scope: AdapterScope): string | undefined {
	return scope.providerId ?? stringMetadata(scope, "run_id");
}

function stringMetadata(scope: AdapterScope, key: string): string | undefined {
	const value = scope.metadata?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mem0Body(value: Record<string, unknown>): { [key: string]: JsonValue } {
	const entries = Object.entries(value)
		.filter(([, entry]) => entry !== undefined)
		.map(([key, entry]) => [key, toJsonValue(entry)] as const);
	return Object.fromEntries(entries);
}

function toJsonObject(value: Record<string, unknown> | undefined): { [key: string]: JsonValue } | undefined {
	if (!value) return undefined;
	const entries = Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)] as const);
	return Object.fromEntries(entries);
}

function toJsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map(toJsonValue);
	if (typeof value === "object") return toJsonObject(value as Record<string, unknown>) ?? null;
	return String(value);
}


function firstMemoryId(json: JsonValue): string | undefined {
	if (!json || typeof json !== "object") return undefined;
	if (Array.isArray(json)) {
		for (const item of json) {
			const id = firstMemoryId(item);
			if (id) return id;
		}
		return undefined;
	}
	for (const key of ["id", "memory_id", "memoryId"] as const) {
		const value = json[key];
		if (typeof value === "string") return value;
	}
	for (const key of ["results", "memories", "items"] as const) {
		const value = json[key];
		const id = firstMemoryId(value);
		if (id) return id;
	}
	return undefined;
}


function isUnavailable(message: string): boolean {
	return message.includes("fetch failed") || message.includes("ECONNREFUSED") || message.includes("AbortError") || message.includes("HTTP 401");
}

async function waitForRecall(adapter: Mem0Adapter, scope: AdapterScope, prompt: string, ...needles: string[]): Promise<boolean> {
	const deadline = Date.now() + Number(process.env.MEM0_RECALL_TIMEOUT_MS ?? DEFAULT_RECALL_TIMEOUT_MS);
	while (Date.now() <= deadline) {
		const result = await adapter.run({ scope, prompt });
		if (needles.every((needle) => result.output.includes(needle))) return true;
		await delay(Number(process.env.MEM0_RECALL_POLL_MS ?? DEFAULT_RECALL_POLL_MS));
	}
	return false;
}

async function waitForMiss(adapter: Mem0Adapter, scope: AdapterScope, prompt: string, ...needles: string[]): Promise<boolean> {
	const deadline = Date.now() + Number(process.env.MEM0_MISS_TIMEOUT_MS ?? DEFAULT_MISS_TIMEOUT_MS);
	while (Date.now() <= deadline) {
		const result = await adapter.run({ scope, prompt });
		if (!needles.some((needle) => result.output.includes(needle))) return true;
		await delay(Number(process.env.MEM0_RECALL_POLL_MS ?? DEFAULT_RECALL_POLL_MS));
	}
	return false;
}

function skippedSmoke(scope: AdapterScope, message: string, apiUrl: string | null = null, exported: AdapterExport | null = null): Mem0SmokeResult {
	return {
		schema_version: "memswe-mem0-smoke.v0.1",
		created_at: new Date().toISOString(),
		api_url: apiUrl,
		scope_id: scope.id,
		status: "skipped",
		predicate_results: {},
		settle_ms: null,
		export: exported,
		error: {
			failed_phase: "preflight",
			message,
			guidance: "Start self-hosted Mem0, set MEM0_API_URL, and set MEM0_API_KEY when auth is enabled.",
		},
	};
}

function failedPhase(exported: AdapterExport): string {
	const errorTrace = [...exported.traces].reverse().find((trace) => trace.errors.length > 0);
	const error = errorTrace?.errors.at(-1);
	return error?.operation ?? "predicate";
}

async function main(): Promise<void> {
	const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	const artifactsDir = join(RUNS_ROOT, timestamp, "mem0-local-smoke");
	await mkdir(artifactsDir, { recursive: true });
	const result = await runMem0LifecycleSmoke();
	const resultPath = join(artifactsDir, "mem0-smoke-result.json");
	await writeFile(resultPath, `${JSON.stringify(result, null, "\t")}\n`);
	console.log(`Mem0 lifecycle smoke ${result.status}${result.settle_ms != null ? ` (settle ${result.settle_ms}ms)` : ""}`);
	console.log(`Wrote ${relative(REPO_ROOT, resultPath)}`);
	if (result.error) console.log(result.error.guidance);
	if (result.status === "failed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
