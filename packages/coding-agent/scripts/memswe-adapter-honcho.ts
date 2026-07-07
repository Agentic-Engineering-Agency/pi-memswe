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
import { mintRunScopeId } from "./memswe-adapter-contract.ts";

// Honcho adapter (AGE-150). Self-hosted "identity layer" memory service (github.com/plastic-labs/honcho),
// deployed via Coolify (memswe/deploy/coolify/honcho). Mirrors the Graphiti/Supermemory adapters: writes are
// derived ASYNCHRONOUSLY by a background deriver, so recall is poll-until-recall (a naive read-after-write
// races the deriver and yields false misses).
//
// BENCHMARK-SAFE reset: each repetition uses a UNIQUE per-run workspace (scope.id) so runs are
// namespace-isolated, and reset/delete calls `DELETE /v3/workspaces/{id}` (Honcho background-deletes every
// peer/session/message/derived fact for the workspace). reset also re-creates the workspace+peer+session so
// subsequent seeds have a home.
//
// REST (Honcho v3, optional Bearer auth — self-host may run USE_AUTH=false):
//   POST   /v3/workspaces                                   get-or-create workspace {id}
//   DELETE /v3/workspaces/{ws}                              background-delete the whole workspace
//   POST   /v3/workspaces/{ws}/peers                        get-or-create peer {id}
//   POST   /v3/workspaces/{ws}/sessions                     get-or-create session {id, peers?}
//   POST   /v3/workspaces/{ws}/sessions/{s}/messages        {messages:[{content, peer_id}]} (async derive)
//   POST   /v3/workspaces/{ws}/peers/{peer}/chat            dialectic recall {query} -> {content}
//   POST   /v3/workspaces/{ws}/peers/{peer}/representation  {search_query?} -> {representation}
//   GET    /v3/workspaces/{ws}/queue/status                 deriver backlog {pending,in_progress,...}
// Verified vs honcho.dev/docs/v3/openapi.json 2026 (contract text says "v2"; upstream HONCHO_GIT_REF=main is v3).

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const RUNS_ROOT = join(REPO_ROOT, ".memswe-runs");
const PROVIDER_ID = "honcho";
const DEFAULT_SELFHOST_API_URL = "http://localhost:8000";
// Honcho Cloud (managed platform, app.honcho.dev keys). Per AGE-158 the cloud key is tried against cloud
// FIRST, then the SAME key is retried against HONCHO_API_URL (self-host) if the cloud attempt is unreachable.
const DEFAULT_CLOUD_API_URL = "https://api.honcho.dev";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RECALL_TIMEOUT_MS = 60_000;
const DEFAULT_RECALL_POLL_MS = 2_000;
const DEFAULT_MISS_TIMEOUT_MS = 20_000;
// Single logical peer/session per run workspace. Honcho derives a per-peer representation, so one peer
// carries the run's memory and `chat`/`representation` target it.
const PEER_ID = "memswe-user";
const SESSION_ID = "memswe-session";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type HonchoAdapterOptions = {
	apiUrl?: string;
	apiKey?: string;
	workspaceId?: string;
	timeoutMs?: number;
};

type HonchoRequestOptions = {
	method: string;
	path: string;
	operation: MemoryOperation;
	scope: AdapterScope;
	body?: JsonValue;
	allowNotFound?: boolean;
	allowForbidden?: boolean;
};

type HonchoResponse = {
	status: number;
	json: JsonValue;
	latencyMs: number;
};

type HonchoSmokeResult = {
	schema_version: "memswe-honcho-smoke.v0.1";
	created_at: string;
	api_url: string | null;
	scope_id: string;
	workspace_id: string | null;
	status: "passed" | "failed" | "skipped";
	predicate_results: Record<string, boolean>;
	settle_ms: number | null;
	export: AdapterExport | null;
	// Which endpoint kind actually ran the lifecycle (cloud is tried first, self-host is the fallback).
	endpoint?: "cloud" | "selfhost";
	// Per-endpoint attempt log so a fallback chain (cloud unreachable → self-host) is auditable.
	attempts?: { endpoint: "cloud" | "selfhost"; api_url: string; status: "passed" | "failed" | "skipped"; message?: string }[];
	error?: {
		failed_phase: string;
		message: string;
		guidance: string;
	};
};

export class HonchoAdapter implements AmsAdapter {
	private readonly apiUrl: string;
	private readonly apiKey?: string;
	private readonly timeoutMs: number;
	private readonly traces: NormalizedTrace[] = [];
	private readonly artifacts: NormalizedArtifact[] = [];

	constructor(options: HonchoAdapterOptions = {}) {
		this.apiUrl = (options.apiUrl ?? DEFAULT_SELFHOST_API_URL).replace(/\/$/, "");
		this.apiKey = options.apiKey;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** Provable per-repetition reset: background-delete the run workspace, then recreate workspace+peer+session. */
	async reset(scope: AdapterScope): Promise<NormalizedTrace> {
		const trace = emptyTrace(scope);
		const workspaceId = this.workspaceId(scope);
		// Honcho refuses to delete a workspace while sessions remain (HTTP 409); delete the session first.
		// Tolerate a missing session/workspace (first run) and a forbidden delete (shared key without admin).
		await this.captureRequest(trace, {
			method: "DELETE",
			path: `/v3/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(SESSION_ID)}`,
			operation: "delete",
			scope,
			allowNotFound: true,
			allowForbidden: true,
		});
		await this.captureRequest(trace, {
			method: "DELETE",
			path: `/v3/workspaces/${encodeURIComponent(workspaceId)}`,
			operation: "delete",
			scope,
			allowNotFound: true,
			allowForbidden: true,
		});
		await this.ensureWorkspace(trace, scope);
		return this.recordTrace(trace);
	}

	async seed(events: AdapterSeedEvent[]): Promise<NormalizedTrace> {
		if (events.length === 0) throw new Error("HonchoAdapter.seed requires at least one event");
		const firstScope = events[0]?.scope;
		if (!firstScope) throw new Error("HonchoAdapter.seed requires scoped events");
		const trace = emptyTrace(firstScope);
		// Idempotent get-or-create so seeding works even without a preceding reset().
		await this.ensureWorkspace(trace, firstScope);
		for (const event of events) {
			if (event.scope.id !== firstScope.id) throw new Error("HonchoAdapter.seed received mixed scopes");
			const response = await this.captureRequest(trace, {
				method: "POST",
				path: `/v3/workspaces/${encodeURIComponent(this.workspaceId(event.scope))}/sessions/${encodeURIComponent(SESSION_ID)}/messages`,
				operation: "write",
				scope: event.scope,
				// Messages are attributed to the run peer; the deriver extracts facts asynchronously.
				body: honchoBody({ messages: [{ content: event.content, peer_id: PEER_ID, metadata: { memswe: true } }] }),
			});
			const messageId = firstMessageId(response.json);
			const lastEvent = trace.events.at(-1);
			if (lastEvent && messageId) lastEvent.memoryId = messageId;
		}
		return this.recordTrace(trace);
	}

	async run(input: AdapterRunInput): Promise<AdapterRunResult> {
		const trace = emptyTrace(input.scope);
		// Dialectic chat queries the derived representation with natural language — the recall path.
		const response = await this.captureRequest(trace, {
			method: "POST",
			path: `/v3/workspaces/${encodeURIComponent(this.workspaceId(input.scope))}/peers/${encodeURIComponent(PEER_ID)}/chat`,
			operation: "retrieve",
			scope: input.scope,
			body: honchoBody({ query: input.prompt, session_id: SESSION_ID }),
		});
		const output = readString(response.json, "content") ?? JSON.stringify(response.json);
		trace.injectedMemoryTokens = Math.ceil(output.length / 4);
		const lastEvent = trace.events.at(-1);
		if (lastEvent) lastEvent.injectedMemoryTokens = trace.injectedMemoryTokens;
		const recorded = this.recordTrace(trace);
		return { output, trace: recorded };
	}

	async observe(): Promise<NormalizedTrace> {
		const scope = this.lastScope();
		const trace = emptyTrace(scope);
		// The peer representation is the structured store of everything Honcho has derived about the peer.
		await this.captureRequest(trace, {
			method: "POST",
			path: `/v3/workspaces/${encodeURIComponent(this.workspaceId(scope))}/peers/${encodeURIComponent(PEER_ID)}/representation`,
			operation: "retrieve",
			scope,
			body: honchoBody({ session_id: SESSION_ID, search_query: "all stored facts about the subject" }),
		});
		return this.recordTrace(trace);
	}

	async delete(scope: AdapterScope): Promise<NormalizedTrace> {
		const trace = emptyTrace(scope);
		const workspaceId = this.workspaceId(scope);
		// Honcho refuses to delete a workspace while sessions remain (HTTP 409), so tear the session down first.
		await this.captureRequest(trace, {
			method: "DELETE",
			path: `/v3/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(SESSION_ID)}`,
			operation: "delete",
			scope,
			allowNotFound: true,
			allowForbidden: true,
		});
		await this.captureRequest(trace, {
			method: "DELETE",
			path: `/v3/workspaces/${encodeURIComponent(workspaceId)}`,
			operation: "delete",
			scope,
			allowNotFound: true,
			allowForbidden: true,
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

	/** Deriver backlog for a workspace (null when unknown) — lets the smoke wait for async extraction to settle. */
	async pendingWorkUnits(scope: AdapterScope): Promise<number | null> {
		const trace = emptyTrace(scope);
		const response = await this.captureRequest(trace, {
			method: "GET",
			path: `/v3/workspaces/${encodeURIComponent(this.workspaceId(scope))}/queue/status?session_id=${encodeURIComponent(SESSION_ID)}`,
			operation: "retrieve",
			scope,
			allowNotFound: true,
		});
		this.recordTrace(trace);
		const pending = readNumber(response.json, "pending_work_units") ?? 0;
		const inProgress = readNumber(response.json, "in_progress_work_units") ?? 0;
		if (response.json === null) return null;
		return pending + inProgress;
	}

	private workspaceId(scope: AdapterScope): string {
		return sanitizeHonchoId(scope.id);
	}

	/** Idempotent get-or-create of the workspace, run peer, and session (Honcho POSTs are get-or-create). */
	private async ensureWorkspace(trace: NormalizedTrace, scope: AdapterScope): Promise<void> {
		const workspaceId = this.workspaceId(scope);
		await this.captureRequest(trace, {
			method: "POST",
			path: "/v3/workspaces",
			operation: "write",
			scope,
			body: honchoBody({ id: workspaceId, metadata: { memswe: true } }),
		});
		await this.captureRequest(trace, {
			method: "POST",
			path: `/v3/workspaces/${encodeURIComponent(workspaceId)}/peers`,
			operation: "write",
			scope,
			body: honchoBody({ id: PEER_ID, metadata: { memswe: true } }),
		});
		await this.captureRequest(trace, {
			method: "POST",
			path: `/v3/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
			operation: "write",
			scope,
			// Attach the run peer to the session so its messages are derived into that peer's representation.
			body: honchoBody({ id: SESSION_ID, peers: { [PEER_ID]: {} }, metadata: { memswe: true } }),
		});
	}

	private async captureRequest(trace: NormalizedTrace, options: HonchoRequestOptions): Promise<HonchoResponse> {
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
					(options.allowForbidden && response.status === 403);
				if (!response.ok && !tolerated) {
					throw new Error(`Honcho ${options.method} ${options.path} failed with HTTP ${response.status}: ${text}`);
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
		if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
		return headers;
	}

	private recordTrace(trace: NormalizedTrace): NormalizedTrace {
		this.traces.push(trace);
		return trace;
	}

	private lastScope(): AdapterScope {
		const lastTrace = this.traces.at(-1);
		if (!lastTrace) throw new Error("HonchoAdapter.observe requires a previous scoped operation");
		return { id: lastTrace.scopeId };
	}
}

/**
 * Cloud-first lifecycle smoke (AGE-158). Per founder: try the cloud key against Honcho Cloud FIRST; if that
 * endpoint is unreachable, retry the SAME key against HONCHO_API_URL (self-host). A definitive cloud result
 * (passed/failed with predicates evaluated) is returned as-is — only an UNREACHABLE cloud (skipped:
 * fetch failed / ECONNREFUSED / 401 / timeout) triggers the self-host fallback. The endpoint that actually
 * ran, and the full attempt chain, are recorded on the result.
 */
export async function runHonchoLifecycleSmoke(): Promise<HonchoSmokeResult> {
	const apiKey = process.env.HONCHO_API_KEY;
	const selfhostUrl = process.env.HONCHO_API_URL ?? DEFAULT_SELFHOST_API_URL;
	const cloudUrl = process.env.HONCHO_CLOUD_API_URL ?? DEFAULT_CLOUD_API_URL;
	const attempts: NonNullable<HonchoSmokeResult["attempts"]> = [];

	// Attempt 1: cloud, gated on a cloud key (Honcho Cloud requires Bearer auth).
	let cloudResult: HonchoSmokeResult | null = null;
	if (apiKey) {
		cloudResult = await runHonchoLifecycleSmokeAgainst(cloudUrl, apiKey);
		attempts.push({ endpoint: "cloud", api_url: cloudUrl, status: cloudResult.status, message: cloudResult.error?.message });
		// A definitive cloud verdict (server reachable, predicates evaluated) is authoritative — return it.
		if (cloudResult.status !== "skipped") return { ...cloudResult, endpoint: "cloud", attempts };
	} else {
		attempts.push({ endpoint: "cloud", api_url: cloudUrl, status: "skipped", message: "HONCHO_API_KEY not set; skipping cloud attempt" });
	}

	// Attempt 2: self-host fallback (same key; a self-host running USE_AUTH=false ignores it).
	const selfhostResult = await runHonchoLifecycleSmokeAgainst(selfhostUrl, apiKey);
	attempts.push({ endpoint: "selfhost", api_url: selfhostUrl, status: selfhostResult.status, message: selfhostResult.error?.message });
	if (selfhostResult.status !== "skipped") return { ...selfhostResult, endpoint: "selfhost", attempts };

	// Both endpoints unreachable → surface the self-host skip (with the full attempt chain for triage).
	return { ...(cloudResult && cloudResult.status === "skipped" ? cloudResult : selfhostResult), attempts };
}

/** Run the retain→recall→delete→miss lifecycle against ONE Honcho endpoint. */
async function runHonchoLifecycleSmokeAgainst(apiUrl: string, apiKey: string | undefined): Promise<HonchoSmokeResult> {
	const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	const scope: AdapterScope = { id: mintRunScopeId("honcho-smoke", timestamp) };
	const adapter = new HonchoAdapter({
		apiUrl,
		apiKey,
		timeoutMs: Number(process.env.HONCHO_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
	});
	const predicates: Record<string, boolean> = {};
	let settleMs: number | null = null;
	const workspaceId = sanitizeHonchoId(scope.id);
	try {
		await adapter.reset(scope);
		predicates.reset_completed = true;
		const content = `MemSWE Honcho smoke fact ${scope.id}: retain recall delete lifecycle marker.`;
		await adapter.seed([{ scope, operation: "write", content, metadata: { smoke: true } }]);
		predicates.retain_completed = true;
		// Async derivation → poll dialectic chat until the marker surfaces; record settle time.
		const settleStart = Date.now();
		const retained = await waitForRecall(adapter, scope, `Find lifecycle marker for ${scope.id}`, scope.id, "lifecycle marker");
		settleMs = retained ? Date.now() - settleStart : null;
		predicates.recall_after_retain = retained;
		await adapter.observe();
		predicates.observe_completed = true;
		await adapter.delete(scope);
		predicates.delete_completed = true;
		// Reset-safety proof: after delete the marker must NOT be recallable (poll for the miss).
		const missed = await waitForMiss(adapter, scope, `Find lifecycle marker for ${scope.id}`, scope.id, "lifecycle marker");
		predicates.recall_miss_after_delete = missed;
		const exported = await adapter.export();
		return {
			schema_version: "memswe-honcho-smoke.v0.1",
			created_at: new Date().toISOString(),
			api_url: apiUrl,
			scope_id: scope.id,
			workspace_id: workspaceId,
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
			schema_version: "memswe-honcho-smoke.v0.1",
			created_at: new Date().toISOString(),
			api_url: apiUrl,
			scope_id: scope.id,
			workspace_id: workspaceId,
			status: "failed",
			predicate_results: predicates,
			settle_ms: settleMs,
			export: exported,
			error: {
				failed_phase: failedPhase(exported),
				message,
				guidance: "Honcho was reachable but lifecycle predicates failed; inspect the normalized trace before using this condition in benchmark pilots.",
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

// Honcho ids allow letters, digits, `_` and `-`; mintRunScopeId already yields that shape, but sanitize to be safe.
function sanitizeHonchoId(id: string): string {
	const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	return cleaned.slice(0, 100) || "memswe";
}

function honchoBody(value: Record<string, unknown>): { [key: string]: JsonValue } {
	const entries = Object.entries(value)
		.filter(([, entry]) => entry !== undefined)
		.map(([key, entry]) => [key, toJsonValue(entry)] as const);
	return Object.fromEntries(entries);
}

function toJsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map(toJsonValue);
	if (typeof value === "object") return honchoBody(value as Record<string, unknown>);
	return String(value);
}

/** Read a string field from a JSON object, narrowing the union so the access is compiler-checked (no cast). */
function readString(json: JsonValue, key: string): string | null {
	if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
	const value = json[key];
	return typeof value === "string" ? value : null;
}

/** Read a number field from a JSON object, narrowing the union so the access is compiler-checked (no cast). */
function readNumber(json: JsonValue, key: string): number | null {
	if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
	const value = json[key];
	return typeof value === "number" ? value : null;
}

/** First message id from a `POST .../messages` array response (used to tag the seed trace event). */
function firstMessageId(json: JsonValue): string | null {
	if (!Array.isArray(json)) return null;
	const first = json[0];
	return readString(first ?? null, "id");
}

async function waitForRecall(adapter: HonchoAdapter, scope: AdapterScope, prompt: string, ...needles: string[]): Promise<boolean> {
	const deadline = Date.now() + Number(process.env.HONCHO_RECALL_TIMEOUT_MS ?? DEFAULT_RECALL_TIMEOUT_MS);
	while (Date.now() <= deadline) {
		const result = await adapter.run({ scope, prompt });
		if (needles.every((needle) => result.output.includes(needle))) return true;
		await delay(Number(process.env.HONCHO_RECALL_POLL_MS ?? DEFAULT_RECALL_POLL_MS));
	}
	return false;
}

async function waitForMiss(adapter: HonchoAdapter, scope: AdapterScope, prompt: string, ...needles: string[]): Promise<boolean> {
	const deadline = Date.now() + Number(process.env.HONCHO_MISS_TIMEOUT_MS ?? DEFAULT_MISS_TIMEOUT_MS);
	while (Date.now() <= deadline) {
		let output: string;
		try {
			output = (await adapter.run({ scope, prompt })).output;
		} catch (caught) {
			// A deleted session/workspace makes the recall probe 404 — that IS the miss (the namespace is gone).
			const message = caught instanceof Error ? caught.message : String(caught);
			if (/HTTP 404/.test(message) && /not found/i.test(message)) return true;
			throw caught;
		}
		if (!needles.some((needle) => output.includes(needle))) return true;
		await delay(Number(process.env.HONCHO_RECALL_POLL_MS ?? DEFAULT_RECALL_POLL_MS));
	}
	return false;
}

function isUnavailable(message: string): boolean {
	return message.includes("fetch failed") || message.includes("ECONNREFUSED") || message.includes("AbortError") || message.includes("HTTP 401");
}

function skippedSmoke(scope: AdapterScope, message: string, apiUrl: string | null = null, exported: AdapterExport | null = null): HonchoSmokeResult {
	return {
		schema_version: "memswe-honcho-smoke.v0.1",
		created_at: new Date().toISOString(),
		api_url: apiUrl,
		scope_id: scope.id,
		workspace_id: null,
		status: "skipped",
		predicate_results: {},
		settle_ms: null,
		export: exported,
		error: {
			failed_phase: "preflight",
			message,
			guidance: "Set HONCHO_API_URL to a reachable Honcho instance (self-host via memswe/deploy/coolify/honcho) to run the live lifecycle smoke. Set HONCHO_API_KEY only when the server runs USE_AUTH=true.",
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
	const artifactsDir = join(RUNS_ROOT, timestamp, "honcho-selfhost-smoke");
	await mkdir(artifactsDir, { recursive: true });
	const result = await runHonchoLifecycleSmoke();
	const resultPath = join(artifactsDir, "honcho-smoke-result.json");
	await writeFile(resultPath, `${JSON.stringify(result, null, "\t")}\n`);
	console.log(`Honcho lifecycle smoke ${result.status}${result.settle_ms != null ? ` (settle ${result.settle_ms}ms)` : ""}`);
	console.log(`Wrote ${relative(REPO_ROOT, resultPath)}`);
	if (result.error) console.log(result.error.guidance);
	if (result.status === "failed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
