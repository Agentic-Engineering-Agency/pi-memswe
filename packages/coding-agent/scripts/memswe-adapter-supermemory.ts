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

// Supermemory adapter (AMB-65). Cloud memory API (https://api.supermemory.ai); CE self-host also exists.
// Mirrors the Graphiti adapter (async ingest + poll-until-recall). The original MemoryBench reference
// provider blocked reportability because clear()/reset was a logger-only no-op. This adapter makes reset
// BENCHMARK-SAFE two ways: (1) each repetition uses a unique per-run CONTAINER TAG (scope.id) so runs are
// namespace-isolated even if a delete is unauthorized; (2) reset/delete clears the namespace via
// `DELETE /v3/container-tags/{tag}` (admin) with a per-document `DELETE /v3/documents/{id}` fallback.
//
// REST (Bearer auth): POST /v3/documents (add; returns {id,status:"queued"} — async), POST /v3/search
// (q + containerTags + limit), DELETE /v3/container-tags/{tag} (deletes all docs+memories for a tag;
// org-admin only), DELETE /v3/documents/{id} (per-doc, 204). Verified vs supermemory.ai/docs 2026-06-25.

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const RUNS_ROOT = join(REPO_ROOT, ".memswe-runs");
const PROVIDER_ID = "supermemory";
const DEFAULT_API_URL = "https://api.supermemory.ai";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RECALL_TIMEOUT_MS = 30_000;
const DEFAULT_RECALL_POLL_MS = 1_500;
const DEFAULT_MISS_TIMEOUT_MS = 15_000;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type SupermemoryAdapterOptions = {
	apiUrl?: string;
	apiKey?: string;
	timeoutMs?: number;
};

type SupermemoryRequestOptions = {
	method: string;
	path: string;
	operation: MemoryOperation;
	scope: AdapterScope;
	body?: JsonValue;
	allowNotFound?: boolean;
	allowForbidden?: boolean;
};

type SupermemoryResponse = {
	status: number;
	json: JsonValue;
	latencyMs: number;
};

type SupermemorySmokeResult = {
	schema_version: "memswe-supermemory-smoke.v0.1";
	created_at: string;
	api_url: string | null;
	scope_id: string;
	container_tag: string | null;
	status: "passed" | "failed" | "skipped";
	predicate_results: Record<string, boolean>;
	settle_ms: number | null;
	deleted_documents: number | null;
	export: AdapterExport | null;
	error?: {
		failed_phase: string;
		message: string;
		guidance: string;
	};
};

export class SupermemoryAdapter implements AmsAdapter {
	private readonly apiUrl: string;
	private readonly apiKey?: string;
	private readonly timeoutMs: number;
	private readonly traces: NormalizedTrace[] = [];
	private readonly artifacts: NormalizedArtifact[] = [];
	// Per-scope document ids returned by seed, used for the per-document delete fallback.
	private readonly documentIds = new Map<string, Set<string>>();
	private lastDeletedDocuments: number | null = null;

	constructor(options: SupermemoryAdapterOptions = {}) {
		this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
		this.apiKey = options.apiKey;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** Clear the per-run container tag namespace — provable per-repetition reset (tolerates a missing/forbidden tag). */
	async reset(scope: AdapterScope): Promise<NormalizedTrace> {
		const trace = emptyTrace(scope);
		await this.clearNamespace(trace, scope);
		this.documentIds.delete(scope.id);
		return this.recordTrace(trace);
	}

	async seed(events: AdapterSeedEvent[]): Promise<NormalizedTrace> {
		if (events.length === 0) throw new Error("SupermemoryAdapter.seed requires at least one event");
		const firstScope = events[0]?.scope;
		if (!firstScope) throw new Error("SupermemoryAdapter.seed requires scoped events");
		const trace = emptyTrace(firstScope);
		let index = 0;
		for (const event of events) {
			if (event.scope.id !== firstScope.id) throw new Error("SupermemoryAdapter.seed received mixed scopes");
			const customId = `${event.scope.id}-${index}`;
			const response = await this.captureRequest(trace, {
				method: "POST",
				path: "/v3/documents",
				operation: "write",
				scope: event.scope,
				// containerTag namespaces the document to this run; customId makes per-doc delete deterministic.
				body: supermemoryBody({ content: event.content, containerTag: event.scope.id, customId, metadata: { memswe: true } }),
			});
			// `POST /v3/documents` returns {id, status:"queued"} — ingestion/extraction is async (poll search to recall).
			const documentId = readString(response.json, "id") ?? customId;
			this.rememberDocumentId(event.scope, documentId);
			const lastEvent = trace.events.at(-1);
			if (lastEvent) lastEvent.memoryId = documentId;
			index += 1;
		}
		return this.recordTrace(trace);
	}

	async run(input: AdapterRunInput): Promise<AdapterRunResult> {
		const trace = emptyTrace(input.scope);
		const response = await this.captureRequest(trace, {
			method: "POST",
			path: "/v3/search",
			operation: "retrieve",
			scope: input.scope,
			body: supermemoryBody({ q: input.prompt, containerTags: [input.scope.id], limit: 10 }),
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
			method: "POST",
			path: "/v3/search",
			operation: "retrieve",
			scope,
			body: supermemoryBody({ q: "all stored facts about the subject", containerTags: [scope.id], limit: 25 }),
		});
		return this.recordTrace(trace);
	}

	async delete(scope: AdapterScope): Promise<NormalizedTrace> {
		const trace = emptyTrace(scope);
		await this.clearNamespace(trace, scope);
		this.documentIds.delete(scope.id);
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

	/** Number of documents the last container-tag delete reported removing (null if unknown / fallback used). */
	get deletedDocumentsCount(): number | null {
		return this.lastDeletedDocuments;
	}

	/**
	 * Delete the whole container-tag namespace; fall back to per-document deletes when the key lacks the
	 * org-admin rights that `DELETE /v3/container-tags` requires (403). Tolerates an absent tag (404).
	 */
	private async clearNamespace(trace: NormalizedTrace, scope: AdapterScope): Promise<void> {
		this.lastDeletedDocuments = null;
		const response = await this.captureRequest(trace, {
			method: "DELETE",
			path: `/v3/container-tags/${encodeURIComponent(scope.id)}`,
			operation: "delete",
			scope,
			allowNotFound: true,
			allowForbidden: true,
		});
		if (response.status === 403) {
			// Container-tag delete is admin-only; delete each known document by id instead (standard-key safe).
			for (const documentId of this.documentIds.get(scope.id) ?? []) {
				await this.captureRequest(trace, {
					method: "DELETE",
					path: `/v3/documents/${encodeURIComponent(documentId)}`,
					operation: "delete",
					scope,
					allowNotFound: true,
				});
			}
			return;
		}
		this.lastDeletedDocuments = readNumber(response.json, "deletedDocumentsCount");
	}

	private async captureRequest(trace: NormalizedTrace, options: SupermemoryRequestOptions): Promise<SupermemoryResponse> {
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
					throw new Error(`Supermemory ${options.method} ${options.path} failed with HTTP ${response.status}: ${text}`);
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
		if (!lastTrace) throw new Error("SupermemoryAdapter.observe requires a previous scoped operation");
		return { id: lastTrace.scopeId };
	}

	private rememberDocumentId(scope: AdapterScope, documentId: string): void {
		const ids = this.documentIds.get(scope.id) ?? new Set<string>();
		ids.add(documentId);
		this.documentIds.set(scope.id, ids);
	}
}

export async function runSupermemoryLifecycleSmoke(): Promise<SupermemorySmokeResult> {
	const apiKey = process.env.SUPERMEMORY_API_KEY;
	const apiUrl = process.env.SUPERMEMORY_API_URL ?? DEFAULT_API_URL;
	const scope: AdapterScope = { id: `memswe-supermemory-smoke-${Date.now()}` };
	// Supermemory Cloud is key-gated: without a key the condition is unavailable → skipped (not failed).
	if (!apiKey) return skippedSmoke(scope, "SUPERMEMORY_API_KEY is not set");

	const adapter = new SupermemoryAdapter({
		apiUrl,
		apiKey,
		timeoutMs: Number(process.env.SUPERMEMORY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
	});
	const predicates: Record<string, boolean> = {};
	let settleMs: number | null = null;
	try {
		await adapter.reset(scope);
		predicates.reset_completed = true;
		const content = `MemSWE Supermemory smoke fact ${scope.id}: retain recall delete lifecycle marker.`;
		await adapter.seed([{ scope, operation: "write", content, metadata: { smoke: true } }]);
		predicates.retain_completed = true;
		// Async ingestion → poll search until the marker surfaces; record settle time.
		const settleStart = Date.now();
		const retained = await waitForRecall(adapter, scope, `Find lifecycle marker for ${scope.id}`, scope.id, "lifecycle marker");
		settleMs = retained ? Date.now() - settleStart : null;
		predicates.recall_after_retain = retained;
		await adapter.observe();
		predicates.observe_completed = true;
		await adapter.delete(scope);
		predicates.delete_completed = true;
		// Reset-safety proof: after delete the marker must NOT be recallable (poll for the miss).
		const missed = await waitForMiss(adapter, scope, `Find lifecycle marker for ${scope.id}`, scope.id);
		predicates.recall_miss_after_delete = missed;
		const exported = await adapter.export();
		return {
			schema_version: "memswe-supermemory-smoke.v0.1",
			created_at: new Date().toISOString(),
			api_url: apiUrl,
			scope_id: scope.id,
			container_tag: scope.id,
			status: Object.values(predicates).every(Boolean) ? "passed" : "failed",
			predicate_results: predicates,
			settle_ms: settleMs,
			deleted_documents: adapter.deletedDocumentsCount,
			export: exported,
		};
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		const exported = await adapter.export();
		if (isUnavailable(message)) return skippedSmoke(scope, message, apiUrl, exported);
		return {
			schema_version: "memswe-supermemory-smoke.v0.1",
			created_at: new Date().toISOString(),
			api_url: apiUrl,
			scope_id: scope.id,
			container_tag: scope.id,
			status: "failed",
			predicate_results: predicates,
			settle_ms: settleMs,
			deleted_documents: adapter.deletedDocumentsCount,
			export: exported,
			error: {
				failed_phase: failedPhase(exported),
				message,
				guidance: "Supermemory was reachable but lifecycle predicates failed; inspect the normalized trace before using this condition in benchmark pilots.",
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

function supermemoryBody(value: Record<string, unknown>): { [key: string]: JsonValue } {
	const entries = Object.entries(value)
		.filter(([, entry]) => entry !== undefined)
		.map(([key, entry]) => [key, toJsonValue(entry)] as const);
	return Object.fromEntries(entries);
}

function toJsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map(toJsonValue);
	if (typeof value === "object") return supermemoryBody(value as Record<string, unknown>);
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

async function waitForRecall(adapter: SupermemoryAdapter, scope: AdapterScope, prompt: string, ...needles: string[]): Promise<boolean> {
	const deadline = Date.now() + Number(process.env.SUPERMEMORY_RECALL_TIMEOUT_MS ?? DEFAULT_RECALL_TIMEOUT_MS);
	while (Date.now() <= deadline) {
		const result = await adapter.run({ scope, prompt });
		if (needles.every((needle) => result.output.includes(needle))) return true;
		await delay(Number(process.env.SUPERMEMORY_RECALL_POLL_MS ?? DEFAULT_RECALL_POLL_MS));
	}
	return false;
}

async function waitForMiss(adapter: SupermemoryAdapter, scope: AdapterScope, prompt: string, ...needles: string[]): Promise<boolean> {
	const deadline = Date.now() + Number(process.env.SUPERMEMORY_MISS_TIMEOUT_MS ?? DEFAULT_MISS_TIMEOUT_MS);
	while (Date.now() <= deadline) {
		const result = await adapter.run({ scope, prompt });
		if (!needles.some((needle) => result.output.includes(needle))) return true;
		await delay(Number(process.env.SUPERMEMORY_RECALL_POLL_MS ?? DEFAULT_RECALL_POLL_MS));
	}
	return false;
}

function isUnavailable(message: string): boolean {
	return message.includes("fetch failed") || message.includes("ECONNREFUSED") || message.includes("AbortError") || message.includes("HTTP 401");
}

function skippedSmoke(scope: AdapterScope, message: string, apiUrl: string | null = null, exported: AdapterExport | null = null): SupermemorySmokeResult {
	return {
		schema_version: "memswe-supermemory-smoke.v0.1",
		created_at: new Date().toISOString(),
		api_url: apiUrl,
		scope_id: scope.id,
		container_tag: null,
		status: "skipped",
		predicate_results: {},
		settle_ms: null,
		deleted_documents: null,
		export: exported,
		error: {
			failed_phase: "preflight",
			message,
			guidance: "Set SUPERMEMORY_API_KEY (Supermemory Cloud) to run the live lifecycle smoke. Optionally set SUPERMEMORY_API_URL for a self-hosted instance.",
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
	const artifactsDir = join(RUNS_ROOT, timestamp, "supermemory-cloud-smoke");
	await mkdir(artifactsDir, { recursive: true });
	const result = await runSupermemoryLifecycleSmoke();
	const resultPath = join(artifactsDir, "supermemory-smoke-result.json");
	await writeFile(resultPath, `${JSON.stringify(result, null, "\t")}\n`);
	console.log(`Supermemory lifecycle smoke ${result.status}${result.settle_ms != null ? ` (settle ${result.settle_ms}ms)` : ""}`);
	console.log(`Wrote ${relative(REPO_ROOT, resultPath)}`);
	if (result.error) console.log(result.error.guidance);
	if (result.status === "failed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
