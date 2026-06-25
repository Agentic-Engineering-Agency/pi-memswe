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
	NormalizedTraceEvent,
} from "./memswe-adapter-contract.ts";

// Self-hosting recipe (AMB-47) — followable by another coding agent:
//   1. Clone getzep/graphiti; in deploy/, set NEO4J_PASSWORD and OPENAI_API_KEY (LLM + embedder).
//      The bundled FastAPI service (graphiti `server/`) exposes the REST surface this adapter uses.
//   2. `docker compose up` (Neo4j + graph-service) → service on http://127.0.0.1:8000.
//   3. Point the smoke at it: GRAPHITI_API_URL=http://127.0.0.1:8000 \
//        npx tsx packages/coding-agent/scripts/memswe-adapter-graphiti.ts
//   Auth (if enabled): GRAPHITI_API_KEY=<key> or GRAPHITI_AUTH_HEADER="Bearer <token>".
// REST surface: POST /messages (seed group), POST /search (group_ids+query), GET /episodes/{group},
//   DELETE /group/{group} (reset/delete). Group-per-scope (group_id = scope.id) gives run isolation.

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const RUNS_ROOT = join(REPO_ROOT, ".memswe-runs");
const PROVIDER_ID = "graphiti";
const DEFAULT_API_URL = "http://127.0.0.1:8000";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RECALL_TIMEOUT_MS = 15_000;
const DEFAULT_RECALL_POLL_MS = 750;
// After group delete, search the (now-empty) group to prove group-per-scope isolation (post-reset miss).
const DEFAULT_MISS_TIMEOUT_MS = 10_000;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type GraphitiAdapterOptions = {
	apiUrl?: string;
	apiKey?: string;
	authHeader?: string;
	timeoutMs?: number;
};

type GraphitiRequestOptions = {
	method: string;
	path: string;
	operation: MemoryOperation;
	scope: AdapterScope;
	body?: JsonValue;
	allowNotFound?: boolean;
};

type GraphitiResponse = {
	status: number;
	json: JsonValue;
	latencyMs: number;
};

type GraphitiSmokeResult = {
	schema_version: "memswe-graphiti-smoke.v0.1";
	created_at: string;
	api_url: string | null;
	scope_id: string;
	status: "passed" | "failed" | "skipped";
	predicate_results: Record<string, boolean>;
	settle_ms: number | null;
	export: AdapterExport | null;
	error?: {
		failed_phase: string;
		message: string;
		guidance: string;
	};
};

export class GraphitiAdapter implements AmsAdapter {
	private readonly apiUrl: string;
	private readonly apiKey?: string;
	private readonly authHeader?: string;
	private readonly timeoutMs: number;
	private readonly traces: NormalizedTrace[] = [];
	private readonly artifacts: NormalizedArtifact[] = [];
	private readonly episodeIds = new Map<string, Set<string>>();

	constructor(options: GraphitiAdapterOptions = {}) {
		this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
		this.apiKey = options.apiKey;
		this.authHeader = options.authHeader;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async reset(scope: AdapterScope): Promise<NormalizedTrace> {
		const trace = emptyTrace(scope);
		await this.captureRequest(trace, {
			method: "DELETE",
			path: `/group/${encodeURIComponent(scope.id)}`,
			operation: "delete",
			scope,
			allowNotFound: true,
		});
		this.episodeIds.delete(scope.id);
		return this.recordTrace(trace);
	}

	async seed(events: AdapterSeedEvent[]): Promise<NormalizedTrace> {
		if (events.length === 0) throw new Error("GraphitiAdapter.seed requires at least one event");
		const firstScope = events[0]?.scope;
		if (!firstScope) throw new Error("GraphitiAdapter.seed requires scoped events");
		const trace = emptyTrace(firstScope);
		const messages = events.map((event, index) => {
			if (event.scope.id !== firstScope.id) throw new Error("GraphitiAdapter.seed received mixed scopes");
			const episodeId = event.providerId ?? `memswe-${event.scope.id}-${Date.now()}-${index}`;
			this.rememberEpisodeId(event.scope, episodeId);
			return graphitiBody({
				uuid: episodeId,
				name: `memswe ${event.operation} ${index}`,
				role_type: "user",
				role: "memswe",
				content: event.content,
				timestamp: new Date().toISOString(),
				source_description: "MemSWE adapter seed event",
			});
		});
		await this.captureRequest(trace, {
			method: "POST",
			path: "/messages",
			operation: "write",
			scope: firstScope,
			body: graphitiBody({ group_id: firstScope.id, messages }),
		});
		trace.events.at(-1)!.memoryId = [...(this.episodeIds.get(firstScope.id) ?? [])].at(-1);
		return this.recordTrace(trace);
	}

	async run(input: AdapterRunInput): Promise<AdapterRunResult> {
		const trace = emptyTrace(input.scope);
		const response = await this.captureRequest(trace, {
			method: "POST",
			path: "/search",
			operation: "retrieve",
			scope: input.scope,
			body: graphitiBody({ group_ids: [input.scope.id], query: input.prompt, max_facts: 10 }),
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
			path: `/episodes/${encodeURIComponent(scope.id)}?last_n=25`,
			operation: "retrieve",
			scope,
		});
		return this.recordTrace(trace);
	}

	async delete(scope: AdapterScope): Promise<NormalizedTrace> {
		const trace = emptyTrace(scope);
		await this.captureRequest(trace, {
			method: "DELETE",
			path: `/group/${encodeURIComponent(scope.id)}`,
			operation: "delete",
			scope,
		});
		this.episodeIds.delete(scope.id);
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

	private async captureRequest(trace: NormalizedTrace, options: GraphitiRequestOptions): Promise<GraphitiResponse> {
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
				if (!response.ok && !(options.allowNotFound && response.status === 404)) throw new Error(`Graphiti ${options.method} ${options.path} failed with HTTP ${response.status}: ${text}`);
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
		if (this.authHeader) headers.authorization = this.authHeader;
		else if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
		return headers;
	}

	private recordTrace(trace: NormalizedTrace): NormalizedTrace {
		this.traces.push(trace);
		return trace;
	}

	private lastScope(): AdapterScope {
		const lastTrace = this.traces.at(-1);
		if (!lastTrace) throw new Error("GraphitiAdapter.observe requires a previous scoped operation");
		return { id: lastTrace.scopeId };
	}

	private rememberEpisodeId(scope: AdapterScope, episodeId: string): void {
		const ids = this.episodeIds.get(scope.id) ?? new Set<string>();
		ids.add(episodeId);
		this.episodeIds.set(scope.id, ids);
	}
}

export async function runGraphitiLifecycleSmoke(): Promise<GraphitiSmokeResult> {
	const apiUrl = process.env.GRAPHITI_API_URL;
	const scope: AdapterScope = { id: `memswe-graphiti-smoke-${Date.now()}` };
	if (!apiUrl) return skippedSmoke(scope, "GRAPHITI_API_URL is not set");

	const adapter = new GraphitiAdapter({
		apiUrl,
		apiKey: process.env.GRAPHITI_API_KEY,
		authHeader: process.env.GRAPHITI_AUTH_HEADER,
		timeoutMs: Number(process.env.GRAPHITI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
	});
	const predicates: Record<string, boolean> = {};
	let settleMs: number | null = null;
	try {
		await adapter.reset(scope);
		predicates.reset_completed = true;
		const content = `MemSWE Graphiti smoke fact ${scope.id}: retain recall delete lifecycle marker.`;
		await adapter.seed([{ scope, operation: "write", content, metadata: { smoke: true } }]);
		predicates.retain_completed = true;
		// Graphiti extracts facts into the graph asynchronously → poll search; record settle time.
		const settleStart = Date.now();
		const retained = await waitForRecall(adapter, scope, `Find lifecycle marker for ${scope.id}`, scope.id, "lifecycle marker");
		settleMs = retained ? Date.now() - settleStart : null;
		predicates.recall_after_retain = retained;
		await adapter.observe();
		predicates.observe_completed = true;
		await adapter.delete(scope);
		predicates.delete_completed = true;
		// Group-per-scope isolation proof: after the group is deleted, search must not surface the marker.
		predicates.recall_miss_after_delete = await waitForMiss(adapter, scope, `Find lifecycle marker for ${scope.id}`, scope.id);
		const exported = await adapter.export();
		return {
			schema_version: "memswe-graphiti-smoke.v0.1",
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
			schema_version: "memswe-graphiti-smoke.v0.1",
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
				guidance: "Graphiti was reachable but lifecycle predicates failed; inspect normalized trace before using this condition in benchmark pilots.",
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

function graphitiBody(value: Record<string, unknown>): { [key: string]: JsonValue } {
	const entries = Object.entries(value)
		.filter(([, entry]) => entry !== undefined)
		.map(([key, entry]) => [key, toJsonValue(entry)] as const);
	return Object.fromEntries(entries);
}

function toJsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map(toJsonValue);
	if (typeof value === "object") return graphitiBody(value as Record<string, unknown>);
	return String(value);
}

async function waitForRecall(adapter: GraphitiAdapter, scope: AdapterScope, prompt: string, ...needles: string[]): Promise<boolean> {
	const deadline = Date.now() + Number(process.env.GRAPHITI_RECALL_TIMEOUT_MS ?? DEFAULT_RECALL_TIMEOUT_MS);
	while (Date.now() <= deadline) {
		const result = await adapter.run({ scope, prompt });
		if (needles.every((needle) => result.output.includes(needle))) return true;
		await delay(Number(process.env.GRAPHITI_RECALL_POLL_MS ?? DEFAULT_RECALL_POLL_MS));
	}
	return false;
}

async function waitForMiss(adapter: GraphitiAdapter, scope: AdapterScope, prompt: string, ...needles: string[]): Promise<boolean> {
	const deadline = Date.now() + Number(process.env.GRAPHITI_MISS_TIMEOUT_MS ?? DEFAULT_MISS_TIMEOUT_MS);
	while (Date.now() <= deadline) {
		const result = await adapter.run({ scope, prompt });
		if (!needles.some((needle) => result.output.includes(needle))) return true;
		await delay(Number(process.env.GRAPHITI_RECALL_POLL_MS ?? DEFAULT_RECALL_POLL_MS));
	}
	return false;
}

function isUnavailable(message: string): boolean {
	return message.includes("fetch failed") || message.includes("ECONNREFUSED") || message.includes("AbortError") || message.includes("HTTP 401");
}

function skippedSmoke(scope: AdapterScope, message: string, apiUrl: string | null = null, exported: AdapterExport | null = null): GraphitiSmokeResult {
	return {
		schema_version: "memswe-graphiti-smoke.v0.1",
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
			guidance: "Start self-hosted Graphiti, set GRAPHITI_API_URL, and set GRAPHITI_API_KEY or GRAPHITI_AUTH_HEADER when auth is enabled.",
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
	const artifactsDir = join(RUNS_ROOT, timestamp, "graphiti-local-smoke");
	await mkdir(artifactsDir, { recursive: true });
	const result = await runGraphitiLifecycleSmoke();
	const resultPath = join(artifactsDir, "graphiti-smoke-result.json");
	await writeFile(resultPath, `${JSON.stringify(result, null, "\t")}\n`);
	console.log(`Graphiti lifecycle smoke ${result.status}${result.settle_ms != null ? ` (settle ${result.settle_ms}ms)` : ""}`);
	console.log(`Wrote ${relative(REPO_ROOT, resultPath)}`);
	if (result.error) console.log(result.error.guidance);
	if (result.status === "failed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
