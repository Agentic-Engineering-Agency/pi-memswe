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

// Zep Cloud graph-memory adapter (AMB-66). Zep CE was deprecated Apr 2025 → Cloud API only.
// Mirrors the Graphiti adapter (async graph + poll-until-recall) — kept SEPARATE from Graphiti per
// the work package. Reset is provable: DELETE /users/{id} removes all of the user's sessions +
// graph artifacts, so each repetition gets an isolated user_id (delete + recreate).
//
// REST: base https://api.getzep.com; header `Authorization: Api-Key <key>`; v2 endpoints
// POST /api/v2/users, DELETE /api/v2/users/{user_id}, POST /api/v2/graph (add data), POST /api/v2/graph/search.
// Verified live 2026-06-25 vs help.getzep.com/sdk-reference/graph: add data is POST /api/v2/graph (202);
// search uses `max` (not `limit`, ≤50) and `scope` edges|nodes|episodes|auto.

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const RUNS_ROOT = join(REPO_ROOT, ".memswe-runs");
const PROVIDER_ID = "zep";
const DEFAULT_API_URL = "https://api.getzep.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RECALL_TIMEOUT_MS = 30_000;
const DEFAULT_RECALL_POLL_MS = 1_500;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ZepAdapterOptions = {
	apiUrl?: string;
	apiKey?: string;
	timeoutMs?: number;
};

type ZepRequestOptions = {
	method: string;
	path: string;
	operation: MemoryOperation;
	scope: AdapterScope;
	body?: JsonValue;
	allowNotFound?: boolean;
	allowConflict?: boolean;
};

type ZepResponse = {
	status: number;
	json: JsonValue;
	latencyMs: number;
};

type ZepSmokeResult = {
	schema_version: "memswe-zep-smoke.v0.1";
	created_at: string;
	api_url: string | null;
	scope_id: string;
	status: "passed" | "failed" | "skipped";
	predicate_results: Record<string, boolean>;
	settle_ms: number | null;
	// Best-effort, NON-gating: did graph SEARCH surface the seeded fact, and after how long? Zep Cloud
	// extracts facts into the graph eventually-consistently, so this can be false even when the lifecycle
	// passes (gated on deterministic episode-by-uuid recall instead).
	search_recall: { surfaced: boolean; settle_ms: number | null; polls: number };
	export: AdapterExport | null;
	error?: {
		failed_phase: string;
		message: string;
		guidance: string;
	};
};

export class ZepAdapter implements AmsAdapter {
	private readonly apiUrl: string;
	private readonly apiKey?: string;
	private readonly timeoutMs: number;
	private readonly traces: NormalizedTrace[] = [];
	private readonly artifacts: NormalizedArtifact[] = [];
	private seededEpisodeIds: string[] = [];

	constructor(options: ZepAdapterOptions = {}) {
		this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
		this.apiKey = options.apiKey;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** Delete the user's whole graph (sessions + artifacts) then recreate it — provable per-repetition reset. */
	async reset(scope: AdapterScope): Promise<NormalizedTrace> {
		const trace = emptyTrace(scope);
		await this.captureRequest(trace, {
			method: "DELETE",
			path: `/api/v2/users/${encodeURIComponent(scope.id)}`,
			operation: "delete",
			scope,
			allowNotFound: true,
		});
		await this.captureRequest(trace, {
			method: "POST",
			path: "/api/v2/users",
			operation: "write",
			scope,
			body: zepBody({ user_id: scope.id, metadata: { memswe: true } }),
			allowConflict: true,
		});
		return this.recordTrace(trace);
	}

	async seed(events: AdapterSeedEvent[]): Promise<NormalizedTrace> {
		if (events.length === 0) throw new Error("ZepAdapter.seed requires at least one event");
		const firstScope = events[0]?.scope;
		if (!firstScope) throw new Error("ZepAdapter.seed requires scoped events");
		const trace = emptyTrace(firstScope);
		this.seededEpisodeIds = [];
		for (const event of events) {
			if (event.scope.id !== firstScope.id) throw new Error("ZepAdapter.seed received mixed scopes");
			const response = await this.captureRequest(trace, {
				method: "POST",
				path: "/api/v2/graph",
				operation: "write",
				scope: event.scope,
				// type "text" ingests free-form content into the user's graph; Zep extracts facts async.
				body: zepBody({ user_id: event.scope.id, type: "text", data: event.content }),
			});
			// `POST /api/v2/graph` returns the raw episode (uuid + content) synchronously (202). Capturing it
			// lets callers read back the stored content by uuid immediately — deterministic, independent of the
			// async fact-extraction that populates edges/nodes (slow/eventually-consistent on Zep Cloud).
			const uuid = recordUuid(response.json);
			if (uuid) this.seededEpisodeIds.push(uuid);
		}
		return this.recordTrace(trace);
	}

	async run(input: AdapterRunInput): Promise<AdapterRunResult> {
		const trace = emptyTrace(input.scope);
		const response = await this.captureRequest(trace, {
			method: "POST",
			path: "/api/v2/graph/search",
			operation: "retrieve",
			scope: input.scope,
			body: zepBody({ user_id: input.scope.id, query: input.prompt, max: 10 }),
		});
		const output = JSON.stringify(response.json);
		trace.injectedMemoryTokens = Math.ceil(output.length / 4);
		const lastEvent = trace.events.at(-1);
		if (lastEvent) lastEvent.injectedMemoryTokens = trace.injectedMemoryTokens;
		const recorded = this.recordTrace(trace);
		return { output, trace: recorded };
	}

	/** UUIDs of the episodes created by the most recent seed() (synchronous 202 responses). */
	get lastSeededEpisodeIds(): readonly string[] {
		return this.seededEpisodeIds;
	}

	/**
	 * Fetch a single stored episode by UUID (`GET /api/v2/graph/episodes/{uuid}`). The raw episode is
	 * available immediately after seed(), so this is the deterministic retain→recall proof — unlike graph
	 * search, which depends on Zep's eventually-consistent fact extraction.
	 */
	async getEpisode(scope: AdapterScope, episodeId: string): Promise<AdapterRunResult> {
		const trace = emptyTrace(scope);
		const response = await this.captureRequest(trace, {
			method: "GET",
			path: `/api/v2/graph/episodes/${encodeURIComponent(episodeId)}`,
			operation: "retrieve",
			scope,
		});
		const output = JSON.stringify(response.json);
		trace.injectedMemoryTokens = Math.ceil(output.length / 4);
		const lastEvent = trace.events.at(-1);
		if (lastEvent) lastEvent.injectedMemoryTokens = trace.injectedMemoryTokens;
		return { output, trace: this.recordTrace(trace) };
	}

	async observe(): Promise<NormalizedTrace> {
		const scope = this.lastScope();
		const trace = emptyTrace(scope);
		await this.captureRequest(trace, {
			method: "POST",
			path: "/api/v2/graph/search",
			operation: "retrieve",
			scope,
			body: zepBody({ user_id: scope.id, query: "all stored facts about the subject", scope: "edges", max: 25 }),
		});
		return this.recordTrace(trace);
	}

	async delete(scope: AdapterScope): Promise<NormalizedTrace> {
		const trace = emptyTrace(scope);
		await this.captureRequest(trace, {
			method: "DELETE",
			path: `/api/v2/users/${encodeURIComponent(scope.id)}`,
			operation: "delete",
			scope,
			allowNotFound: true,
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

	private async captureRequest(trace: NormalizedTrace, options: ZepRequestOptions): Promise<ZepResponse> {
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
				const tolerated =
					(options.allowNotFound && response.status === 404) ||
					(options.allowConflict && (response.status === 409 || response.status === 400));
				if (!response.ok && !tolerated) {
					throw new Error(`Zep ${options.method} ${options.path} failed with HTTP ${response.status}: ${text}`);
				}
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
		// Zep Cloud auth scheme: `Authorization: Api-Key <key>`.
		if (this.apiKey) headers.authorization = `Api-Key ${this.apiKey}`;
		return headers;
	}

	private recordTrace(trace: NormalizedTrace): NormalizedTrace {
		this.traces.push(trace);
		return trace;
	}

	private lastScope(): AdapterScope {
		const lastTrace = this.traces.at(-1);
		if (!lastTrace) throw new Error("ZepAdapter.observe requires a previous scoped operation");
		return { id: lastTrace.scopeId };
	}
}

export async function runZepLifecycleSmoke(): Promise<ZepSmokeResult> {
	const apiKey = process.env.ZEP_API_KEY;
	const apiUrl = process.env.ZEP_API_URL ?? DEFAULT_API_URL;
	const scope: AdapterScope = { id: `memswe-zep-smoke-${Date.now()}` };
	// Zep is Cloud-only: without a key the condition is unavailable → skipped (not failed).
	if (!apiKey) return skippedSmoke(scope, "ZEP_API_KEY is not set");

	const adapter = new ZepAdapter({
		apiUrl,
		apiKey,
		timeoutMs: Number(process.env.ZEP_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
	});
	const predicates: Record<string, boolean> = {};
	let settleMs: number | null = null;
	try {
		await adapter.reset(scope);
		predicates.reset_completed = true;
		const content = `MemSWE Zep smoke fact ${scope.id}: retain recall delete lifecycle marker.`;
		await adapter.seed([{ scope, operation: "write", content, metadata: { smoke: true } }]);
		predicates.retain_completed = true;
		// Deterministic recall: the seeded episode is readable by UUID immediately (no dependence on Zep's
		// eventually-consistent fact extraction). This is what gates the lifecycle.
		const episodeId = adapter.lastSeededEpisodeIds[0];
		let recalled = false;
		if (episodeId) {
			const byId = await adapter.getEpisode(scope, episodeId);
			recalled = byId.output.includes(scope.id) && byId.output.includes("lifecycle marker");
		}
		predicates.recall_after_retain = recalled;
		// Best-effort, NON-gating: how long until graph SEARCH surfaces the fact (often never within a session
		// window on Zep Cloud). Recorded as a benchmark-relevant settle metric, not a pass/fail gate.
		const search = await waitForSearchRecall(adapter, scope, `Find lifecycle marker for ${scope.id}`, scope.id, "lifecycle marker");
		settleMs = search.settleMs;
		await adapter.observe();
		predicates.observe_completed = true;
		await adapter.delete(scope);
		predicates.delete_completed = true;
		const exported = await adapter.export();
		return {
			schema_version: "memswe-zep-smoke.v0.1",
			created_at: new Date().toISOString(),
			api_url: apiUrl,
			scope_id: scope.id,
			status: Object.values(predicates).every(Boolean) ? "passed" : "failed",
			predicate_results: predicates,
			settle_ms: settleMs,
			search_recall: { surfaced: search.surfaced, settle_ms: search.settleMs, polls: search.polls },
			export: exported,
		};
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		const exported = await adapter.export();
		if (isUnavailable(message)) return skippedSmoke(scope, message, apiUrl, exported);
		return {
			schema_version: "memswe-zep-smoke.v0.1",
			created_at: new Date().toISOString(),
			api_url: apiUrl,
			scope_id: scope.id,
			status: "failed",
			predicate_results: predicates,
			settle_ms: settleMs,
			search_recall: { surfaced: settleMs != null, settle_ms: settleMs, polls: 0 },
			export: exported,
			error: {
				failed_phase: failedPhase(exported),
				message,
				guidance: "Zep was reachable but lifecycle predicates failed; inspect the normalized trace before using this condition in benchmark pilots.",
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

function zepBody(value: Record<string, unknown>): { [key: string]: JsonValue } {
	const entries = Object.entries(value)
		.filter(([, entry]) => entry !== undefined)
		.map(([key, entry]) => [key, toJsonValue(entry)] as const);
	return Object.fromEntries(entries);
}

function toJsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map(toJsonValue);
	if (typeof value === "object") return zepBody(value as Record<string, unknown>);
	return String(value);
}

/** Pulls a `uuid` field out of a Zep JSON response (episode/user/edge create), if present. */
function recordUuid(json: JsonValue): string | null {
	// Narrow the JsonValue union to its object member so the index access is compiler-checked (no cast).
	if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
	const uuid = json.uuid;
	return typeof uuid === "string" && uuid.length > 0 ? uuid : null;
}

/** Best-effort poll of graph SEARCH until the seeded needles surface; reports surfaced flag, settle time, polls. */
async function waitForSearchRecall(adapter: ZepAdapter, scope: AdapterScope, prompt: string, ...needles: string[]): Promise<{ surfaced: boolean; settleMs: number | null; polls: number }> {
	const start = Date.now();
	const deadline = start + Number(process.env.ZEP_RECALL_TIMEOUT_MS ?? DEFAULT_RECALL_TIMEOUT_MS);
	let polls = 0;
	while (Date.now() <= deadline) {
		polls += 1;
		const result = await adapter.run({ scope, prompt });
		if (needles.every((needle) => result.output.includes(needle))) return { surfaced: true, settleMs: Date.now() - start, polls };
		await delay(Number(process.env.ZEP_RECALL_POLL_MS ?? DEFAULT_RECALL_POLL_MS));
	}
	return { surfaced: false, settleMs: null, polls };
}

function isUnavailable(message: string): boolean {
	return message.includes("fetch failed") || message.includes("ECONNREFUSED") || message.includes("AbortError") || message.includes("HTTP 401");
}

function skippedSmoke(scope: AdapterScope, message: string, apiUrl: string | null = null, exported: AdapterExport | null = null): ZepSmokeResult {
	return {
		schema_version: "memswe-zep-smoke.v0.1",
		created_at: new Date().toISOString(),
		api_url: apiUrl,
		scope_id: scope.id,
		status: "skipped",
		predicate_results: {},
		settle_ms: null,
		search_recall: { surfaced: false, settle_ms: null, polls: 0 },
		export: exported,
		error: {
			failed_phase: "preflight",
			message,
			guidance: "Set ZEP_API_KEY (Zep Cloud; CE deprecated Apr 2025) to run the live lifecycle smoke. Optionally set ZEP_API_URL.",
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
	const artifactsDir = join(RUNS_ROOT, timestamp, "zep-cloud-smoke");
	await mkdir(artifactsDir, { recursive: true });
	const result = await runZepLifecycleSmoke();
	const resultPath = join(artifactsDir, "zep-smoke-result.json");
	await writeFile(resultPath, `${JSON.stringify(result, null, "\t")}\n`);
	console.log(`Zep lifecycle smoke ${result.status}${result.settle_ms != null ? ` (settle ${result.settle_ms}ms)` : ""}`);
	console.log(`Wrote ${relative(REPO_ROOT, resultPath)}`);
	if (result.error) console.log(result.error.guidance);
	if (result.status === "failed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
