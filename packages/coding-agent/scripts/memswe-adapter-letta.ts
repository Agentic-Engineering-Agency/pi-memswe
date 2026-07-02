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

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const RUNS_ROOT = join(REPO_ROOT, ".memswe-runs");
const PROVIDER_ID = "letta";
const DEFAULT_API_URL = "http://127.0.0.1:8283/v1";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_EMBEDDING = "openai/text-embedding-3-small";
// Letta embeds each archival passage on write; recall is usually prompt-sync but poll to absorb latency.
const DEFAULT_RECALL_TIMEOUT_MS = 15_000;
const DEFAULT_RECALL_POLL_MS = 1_000;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type LettaAdapterOptions = {
	apiUrl?: string;
	apiKey?: string;
	authHeader?: string;
	timeoutMs?: number;
	model?: string;
	embedding?: string;
};

type LettaRequestOptions = {
	method: string;
	path: string;
	operation: MemoryOperation;
	scope: AdapterScope;
	body?: JsonValue;
};

type LettaResponse = {
	status: number;
	json: JsonValue;
	latencyMs: number;
};

type LettaSmokeResult = {
	schema_version: "memswe-letta-smoke.v0.1";
	created_at: string;
	api_url: string | null;
	scope_id: string;
	status: "passed" | "failed" | "skipped";
	predicate_results: Record<string, boolean>;
	settle_ms: number | null;
	agent_id: string | null;
	// Model/embedding are an experimental variable for Letta → recorded in the artifact (acceptance criterion).
	metadata: { model: string; embedding: string };
	export: AdapterExport | null;
	error?: {
		failed_phase: string;
		message: string;
		guidance: string;
	};
};

export class LettaAdapter implements AmsAdapter {
	private readonly apiUrl: string;
	private readonly apiKey?: string;
	private readonly authHeader?: string;
	private readonly timeoutMs: number;
	private readonly model: string;
	private readonly embedding: string;
	private readonly traces: NormalizedTrace[] = [];
	private readonly artifacts: NormalizedArtifact[] = [];
	private readonly agentIds = new Map<string, string>();
	private readonly memoryIds = new Map<string, Set<string>>();

	constructor(options: LettaAdapterOptions = {}) {
		this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
		this.apiKey = options.apiKey;
		this.authHeader = options.authHeader;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.model = options.model ?? DEFAULT_MODEL;
		this.embedding = options.embedding ?? DEFAULT_EMBEDDING;
	}

	async reset(scope: AdapterScope): Promise<NormalizedTrace> {
		const trace = emptyTrace(scope);
		const existingAgentId = this.agentId(scope);
		if (existingAgentId) {
			await this.captureRequest(trace, {
				method: "DELETE",
				path: `/agents/${encodeURIComponent(existingAgentId)}`,
				operation: "delete",
				scope,
			});
		}
		this.memoryIds.delete(scope.id);
		const response = await this.captureRequest(trace, {
			method: "POST",
			path: "/agents",
			operation: "write",
			scope,
			body: lettaBody({
				model: this.model,
				embedding: this.embedding,
				name: `memswe-${scope.id}`,
			}),
		});
		const agentId = firstString(response.json, ["id", "agent_id", "agentId"]);
		if (!agentId) throw new Error("Letta agent creation did not return an agent id");
		this.agentIds.set(scope.id, agentId);
		trace.events.at(-1)!.memoryId = agentId;
		return this.recordTrace(trace);
	}

	async seed(events: AdapterSeedEvent[]): Promise<NormalizedTrace> {
		if (events.length === 0) throw new Error("LettaAdapter.seed requires at least one event");
		const firstScope = events[0]?.scope;
		if (!firstScope) throw new Error("LettaAdapter.seed requires scoped events");
		const trace = emptyTrace(firstScope);
		for (const event of events) {
			if (event.scope.id !== firstScope.id) throw new Error("LettaAdapter.seed received mixed scopes");
			const response = await this.captureRequest(trace, {
				method: "POST",
				path: `/agents/${encodeURIComponent(this.requireAgentId(event.scope))}/archival-memory`,
				operation: "write",
				scope: event.scope,
				body: lettaBody({
					text: event.content,
					tags: ["memswe", event.scope.id],
					created_at: new Date().toISOString(),
				}),
			});
			const memoryId = firstString(response.json, ["id", "memory_id", "memoryId", "passage_id", "passageId"]);
			if (memoryId) {
				this.rememberMemoryId(event.scope, memoryId);
				trace.events.at(-1)!.memoryId = memoryId;
			}
		}
		return this.recordTrace(trace);
	}

	async run(input: AdapterRunInput): Promise<AdapterRunResult> {
		const trace = emptyTrace(input.scope);
		const params = new URLSearchParams({ query: input.prompt, top_k: "10", tags: input.scope.id, tag_match_mode: "any" });
		const response = await this.captureRequest(trace, {
			method: "GET",
			path: `/agents/${encodeURIComponent(this.requireAgentId(input.scope))}/archival-memory/search?${params.toString()}`,
			operation: "retrieve",
			scope: input.scope,
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
			path: `/agents/${encodeURIComponent(this.requireAgentId(scope))}/archival-memory?limit=200`,
			operation: "retrieve",
			scope,
		});
		return this.recordTrace(trace);
	}

	async delete(scope: AdapterScope): Promise<NormalizedTrace> {
		const trace = emptyTrace(scope);
		const agentId = this.requireAgentId(scope);
		for (const memoryId of this.memoryIds.get(scope.id) ?? []) {
			await this.captureRequest(trace, {
				method: "DELETE",
				path: `/agents/${encodeURIComponent(agentId)}/archival-memory/${encodeURIComponent(memoryId)}`,
				operation: "delete",
				scope,
			});
		}
		await this.captureRequest(trace, {
			method: "DELETE",
			path: `/agents/${encodeURIComponent(agentId)}`,
			operation: "delete",
			scope,
		});
		this.agentIds.delete(scope.id);
		this.memoryIds.delete(scope.id);
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

	/** Configured model/embedding (the Letta experimental variable) — recorded in smoke artifact metadata. */
	get modelName(): string {
		return this.model;
	}
	get embeddingName(): string {
		return this.embedding;
	}

	/** The Letta agent id currently mapped to a scope (set by reset), if any. */
	agentIdFor(scope: AdapterScope): string | undefined {
		return this.agentId(scope);
	}

	private async captureRequest(trace: NormalizedTrace, options: LettaRequestOptions): Promise<LettaResponse> {
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
				if (!response.ok) throw new Error(`Letta ${options.method} ${options.path} failed with HTTP ${response.status}: ${text}`);
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
		if (!lastTrace) throw new Error("LettaAdapter.observe requires a previous scoped operation");
		return { id: lastTrace.scopeId };
	}

	private agentId(scope: AdapterScope): string | undefined {
		return stringMetadata(scope, "agent_id") ?? this.agentIds.get(scope.id);
	}

	private requireAgentId(scope: AdapterScope): string {
		const agentId = this.agentId(scope);
		if (!agentId) throw new Error(`LettaAdapter scope ${scope.id} has no agent id; call reset first or provide metadata.agent_id`);
		return agentId;
	}

	private rememberMemoryId(scope: AdapterScope, memoryId: string): void {
		const ids = this.memoryIds.get(scope.id) ?? new Set<string>();
		ids.add(memoryId);
		this.memoryIds.set(scope.id, ids);
	}
}

export async function runLettaLifecycleSmoke(): Promise<LettaSmokeResult> {
	const apiUrl = process.env.LETTA_API_URL;
	const scope: AdapterScope = { id: `memswe-letta-smoke-${Date.now()}` };
	if (!apiUrl) return skippedSmoke(scope, "LETTA_API_URL is not set");

	const adapter = new LettaAdapter({
		apiUrl,
		apiKey: process.env.LETTA_API_KEY,
		authHeader: process.env.LETTA_AUTH_HEADER,
		timeoutMs: Number(process.env.LETTA_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
		model: process.env.LETTA_MODEL,
		embedding: process.env.LETTA_EMBEDDING,
	});
	const predicates: Record<string, boolean> = {};
	let settleMs: number | null = null;
	let agentId: string | null = null;
	const metadata = { model: adapter.modelName, embedding: adapter.embeddingName };
	try {
		await adapter.reset(scope);
		predicates.reset_completed = true;
		agentId = adapter.agentIdFor(scope) ?? null;
		const content = `MemSWE Letta smoke fact ${scope.id}: retain recall delete lifecycle marker.`;
		await adapter.seed([{ scope, operation: "write", content, metadata: { smoke: true } }]);
		predicates.retain_completed = true;
		// Poll archival search until the passage is embedded + searchable; record settle time.
		const settleStart = Date.now();
		const retained = await waitForRecall(adapter, scope, `Find lifecycle marker for ${scope.id}`, scope.id, "lifecycle marker");
		settleMs = retained ? Date.now() - settleStart : null;
		predicates.recall_after_retain = retained;
		await adapter.observe();
		predicates.observe_completed = true;
		await adapter.delete(scope);
		predicates.delete_completed = true;
		// Post-delete miss: the agent + its archival memory are gone, so a search must not surface the marker.
		// delete() clears the scope→agent map, so address the now-deleted agent explicitly via metadata.
		predicates.recall_miss_after_delete = await searchMissesAfterDelete(adapter, scope, agentId);
		const exported = await adapter.export();
		return {
			schema_version: "memswe-letta-smoke.v0.1",
			created_at: new Date().toISOString(),
			api_url: apiUrl,
			scope_id: scope.id,
			status: Object.values(predicates).every(Boolean) ? "passed" : "failed",
			predicate_results: predicates,
			settle_ms: settleMs,
			agent_id: agentId,
			metadata,
			export: exported,
		};
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		const exported = await adapter.export();
		if (isUnavailable(message)) return skippedSmoke(scope, message, apiUrl, exported);
		return {
			schema_version: "memswe-letta-smoke.v0.1",
			created_at: new Date().toISOString(),
			api_url: apiUrl,
			scope_id: scope.id,
			status: "failed",
			predicate_results: predicates,
			settle_ms: settleMs,
			agent_id: agentId,
			metadata,
			export: exported,
			error: {
				failed_phase: failedPhase(exported),
				message,
				guidance: "Letta was reachable but lifecycle predicates failed; inspect normalized trace before using this condition in benchmark pilots.",
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

function stringMetadata(scope: AdapterScope, key: string): string | undefined {
	const value = scope.metadata?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function lettaBody(value: Record<string, unknown>): { [key: string]: JsonValue } {
	const entries = Object.entries(value)
		.filter(([, entry]) => entry !== undefined)
		.map(([key, entry]) => [key, toJsonValue(entry)] as const);
	return Object.fromEntries(entries);
}

function toJsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map(toJsonValue);
	if (typeof value === "object") return lettaBody(value as Record<string, unknown>);
	return String(value);
}

function firstString(json: JsonValue, keys: readonly string[]): string | undefined {
	if (!json || typeof json !== "object") return undefined;
	if (Array.isArray(json)) {
		for (const item of json) {
			const value = firstString(item, keys);
			if (value) return value;
		}
		return undefined;
	}
	for (const key of keys) {
		const value = json[key];
		if (typeof value === "string") return value;
	}
	for (const value of Object.values(json)) {
		const nested = firstString(value, keys);
		if (nested) return nested;
	}
	return undefined;
}

function isUnavailable(message: string): boolean {
	return message.includes("fetch failed") || message.includes("ECONNREFUSED") || message.includes("AbortError") || message.includes("HTTP 401");
}

async function waitForRecall(adapter: LettaAdapter, scope: AdapterScope, prompt: string, ...needles: string[]): Promise<boolean> {
	const deadline = Date.now() + Number(process.env.LETTA_RECALL_TIMEOUT_MS ?? DEFAULT_RECALL_TIMEOUT_MS);
	while (Date.now() <= deadline) {
		const result = await adapter.run({ scope, prompt });
		if (needles.every((needle) => result.output.includes(needle))) return true;
		await delay(Number(process.env.LETTA_RECALL_POLL_MS ?? DEFAULT_RECALL_POLL_MS));
	}
	return false;
}

/** After delete the agent is gone: a search either misses the marker or 404s — both prove the memory was removed. */
async function searchMissesAfterDelete(adapter: LettaAdapter, scope: AdapterScope, agentId: string | null): Promise<boolean> {
	if (!agentId) return false;
	const missScope: AdapterScope = { id: scope.id, metadata: { agent_id: agentId } };
	try {
		const after = await adapter.run({ scope: missScope, prompt: `Find lifecycle marker for ${scope.id}` });
		return !after.output.includes(scope.id);
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		return /HTTP 404|not.?found/i.test(message);
	}
}

function skippedSmoke(scope: AdapterScope, message: string, apiUrl: string | null = null, exported: AdapterExport | null = null): LettaSmokeResult {
	return {
		schema_version: "memswe-letta-smoke.v0.1",
		created_at: new Date().toISOString(),
		api_url: apiUrl,
		scope_id: scope.id,
		status: "skipped",
		predicate_results: {},
		settle_ms: null,
		agent_id: null,
		metadata: { model: process.env.LETTA_MODEL ?? DEFAULT_MODEL, embedding: process.env.LETTA_EMBEDDING ?? DEFAULT_EMBEDDING },
		export: exported,
		error: {
			failed_phase: "preflight",
			message,
			guidance: "Start self-hosted Letta, set LETTA_API_URL, and set LETTA_API_KEY or LETTA_AUTH_HEADER when auth is enabled.",
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
	const artifactsDir = join(RUNS_ROOT, timestamp, "letta-local-smoke");
	await mkdir(artifactsDir, { recursive: true });
	const result = await runLettaLifecycleSmoke();
	const resultPath = join(artifactsDir, "letta-smoke-result.json");
	await writeFile(resultPath, `${JSON.stringify(result, null, "\t")}\n`);
	console.log(`Letta lifecycle smoke ${result.status}${result.settle_ms != null ? ` (settle ${result.settle_ms}ms)` : ""}`);
	console.log(`Wrote ${relative(REPO_ROOT, resultPath)}`);
	if (result.error) console.log(result.error.guidance);
	if (result.status === "failed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
