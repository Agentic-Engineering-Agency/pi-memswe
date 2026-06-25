#!/usr/bin/env -S npx tsx

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
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

// Local RAG baseline (AMB-67): a deterministic, resettable lexical retrieval index (BM25) over
// chunked seeded content. NO external service / NO embeddings by default — so the lifecycle smoke
// PASSES (not skips) and results are reproducible run-to-run. Distinct from the repository_docs
// baseline (AMB-7): repo_docs injects whole matching docs; LocalRAG chunks content and returns
// top-k scored chunks with explicit retrieval evidence (chunk IDs, BM25 scores, injected tokens).
//
// Reset/rebuild is deterministic: the per-scope index file is removed + rebuilt from the explicit
// corpus, so each repetition is isolated. Optional external embeddings are intentionally OUT of the
// default path to keep the baseline credential-free and deterministic (see EMBEDDINGS note below).

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const RUNS_ROOT = join(REPO_ROOT, ".memswe-runs");
const PROVIDER_ID = "localrag";
const DEFAULT_TOP_K = 5;
const BM25_K1 = 1.5;
const BM25_B = 0.75;

type Chunk = { id: string; text: string; terms: string[] };
type IndexFile = { chunks: Chunk[] };
type ScoredChunk = { id: string; score: number; tokens: number; text: string };

type LocalRagOptions = { indexRoot?: string; topK?: number };

type LocalRagSmokeResult = {
	schema_version: "memswe-localrag-smoke.v0.1";
	created_at: string;
	index_root: string;
	scope_id: string;
	status: "passed" | "failed" | "skipped";
	predicate_results: Record<string, boolean>;
	export: AdapterExport | null;
	error?: { failed_phase: string; message: string; guidance: string };
};

function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
function sanitize(id: string): string {
	// Map any char outside the safe set to "_" — this collapses "/" and "\" so the result is a single
	// path segment. The remaining traversal risk is a DOTS-ONLY segment ("", ".", ".."), which would
	// resolve to cwd or indexRoot's PARENT and let reset()/delete() rm -rf OUTSIDE indexRoot — so map
	// any dots-only id to a safe token.
	const cleaned = id.replace(/[^a-zA-Z0-9_.-]/g, "_");
	return /^\.*$/.test(cleaned) ? "_scope_" : cleaned;
}
function tokenize(text: string): string[] {
	return text.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
}
/** Split content into chunks (one per non-empty line/sentence) so retrieval is sub-document. */
function chunkContent(content: string): string[] {
	return content
		.split(/(?<=[.!?])\s+|\n+/)
		.map((c) => c.trim())
		.filter((c) => c.length > 0);
}

/** Deterministic BM25 over the index; returns top-k chunks by score (>0). */
function bm25(index: IndexFile, query: string, topK: number): ScoredChunk[] {
	const queryTerms = tokenize(query);
	const n = index.chunks.length;
	if (n === 0) return [];
	const avgdl = index.chunks.reduce((sum, c) => sum + c.terms.length, 0) / n || 1;
	const df = new Map<string, number>();
	for (const term of new Set(queryTerms)) {
		df.set(term, index.chunks.filter((c) => c.terms.includes(term)).length);
	}
	const scored = index.chunks.map((chunk) => {
		const dl = chunk.terms.length || 1;
		let score = 0;
		for (const term of queryTerms) {
			const docFreq = df.get(term) ?? 0;
			if (docFreq === 0) continue;
			const tf = chunk.terms.filter((t) => t === term).length;
			const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
			score += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl))));
		}
		return { id: chunk.id, score: Number(score.toFixed(6)), tokens: approxTokens(chunk.text), text: chunk.text };
	});
	return scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
}

export class LocalRagAdapter implements AmsAdapter {
	private readonly indexRoot: string;
	private readonly topK: number;
	private readonly traces: NormalizedTrace[] = [];
	private readonly artifacts: NormalizedArtifact[] = [];
	private lastScopeId?: string;

	constructor(options: LocalRagOptions = {}) {
		this.indexRoot = options.indexRoot ?? join(RUNS_ROOT, "localrag-index");
		this.topK = options.topK ?? DEFAULT_TOP_K;
	}

	private scopeDir(scope: AdapterScope): string {
		const dir = join(this.indexRoot, sanitize(scope.id));
		// Defense-in-depth: the resolved scope dir MUST stay within indexRoot so reset()/delete()
		// (rm -rf) can never escape it even if sanitize is ever weakened.
		const root = resolve(this.indexRoot);
		const resolved = resolve(dir);
		if (resolved !== root && !resolved.startsWith(root + sep)) {
			throw new Error(`LocalRagAdapter: scope ${JSON.stringify(scope.id)} escapes indexRoot`);
		}
		return dir;
	}

	private indexPath(scope: AdapterScope): string {
		return join(this.scopeDir(scope), "index.json");
	}

	private async load(scope: AdapterScope): Promise<IndexFile> {
		try {
			return JSON.parse(await readFile(this.indexPath(scope), "utf8")) as IndexFile;
		} catch {
			return { chunks: [] };
		}
	}
	private async save(scope: AdapterScope, index: IndexFile): Promise<void> {
		await mkdir(dirname(this.indexPath(scope)), { recursive: true });
		await writeFile(this.indexPath(scope), JSON.stringify(index));
	}

	async reset(scope: AdapterScope): Promise<NormalizedTrace> {
		const trace = emptyTrace(scope);
		await this.capture(trace, "delete", scope, `reset index ${sanitize(scope.id)}`, async () => {
			await rm(this.scopeDir(scope), { recursive: true, force: true });
			await this.save(scope, { chunks: [] });
			return "ok";
		});
		this.lastScopeId = scope.id;
		return this.recordTrace(trace);
	}

	async seed(events: AdapterSeedEvent[]): Promise<NormalizedTrace> {
		if (events.length === 0) throw new Error("LocalRagAdapter.seed requires at least one event");
		const firstScope = events[0]?.scope;
		if (!firstScope) throw new Error("LocalRagAdapter.seed requires scoped events");
		const trace = emptyTrace(firstScope);
		const index = await this.load(firstScope);
		for (const event of events) {
			if (event.scope.id !== firstScope.id) throw new Error("LocalRagAdapter.seed received mixed scopes");
			await this.capture(trace, "write", event.scope, event.content, async () => {
				const baseId = event.providerId ?? `ev${index.chunks.length}`;
				const pieces = chunkContent(event.content);
				pieces.forEach((text, i) => index.chunks.push({ id: `${sanitize(baseId)}-c${i}`, text, terms: tokenize(text) }));
				return `indexed ${pieces.length} chunk(s)`;
			});
		}
		await this.save(firstScope, index);
		this.lastScopeId = firstScope.id;
		return this.recordTrace(trace);
	}

	async run(input: AdapterRunInput): Promise<AdapterRunResult> {
		const trace = emptyTrace(input.scope);
		const output = await this.capture(trace, "retrieve", input.scope, input.prompt, async () => {
			const index = await this.load(input.scope);
			const hits = bm25(index, input.prompt, this.topK);
			return JSON.stringify(hits);
		});
		const injectedMemoryTokens = approxTokens(output);
		trace.injectedMemoryTokens = injectedMemoryTokens;
		const lastEvent = trace.events.at(-1);
		if (lastEvent) lastEvent.injectedMemoryTokens = injectedMemoryTokens;
		this.lastScopeId = input.scope.id;
		const recorded = this.recordTrace(trace);
		return { output, trace: recorded };
	}

	async observe(): Promise<NormalizedTrace> {
		const scope = this.lastScope();
		const trace = emptyTrace(scope);
		await this.capture(trace, "retrieve", scope, `index stats ${sanitize(scope.id)}`, async () => {
			const index = await this.load(scope);
			const terms = new Set<string>();
			for (const chunk of index.chunks) for (const term of chunk.terms) terms.add(term);
			return JSON.stringify({ chunks: index.chunks.length, unique_terms: terms.size });
		});
		return this.recordTrace(trace);
	}

	async delete(scope: AdapterScope): Promise<NormalizedTrace> {
		const trace = emptyTrace(scope);
		await this.capture(trace, "delete", scope, `delete index ${sanitize(scope.id)}`, async () => {
			await rm(this.scopeDir(scope), { recursive: true, force: true });
			return "ok";
		});
		return this.recordTrace(trace);
	}

	async export(): Promise<AdapterExport> {
		return { providerId: PROVIDER_ID, scopeId: this.traces.at(-1)?.scopeId, traces: this.traces, artifacts: this.artifacts };
	}

	private async capture(
		trace: NormalizedTrace,
		operation: MemoryOperation,
		scope: AdapterScope,
		input: string,
		fn: () => Promise<string>,
	): Promise<string> {
		const started = Date.now();
		const event: NormalizedTraceEvent = { operation, providerId: PROVIDER_ID, scopeId: scope.id, input, metadata: {} };
		try {
			const output = await fn();
			event.output = output;
			return output;
		} catch (caught) {
			const error = caught instanceof Error ? caught : new Error(String(caught));
			trace.errors.push({ message: error.message, providerId: PROVIDER_ID, operation, code: error.name });
			throw error;
		} finally {
			event.latencyMs = Date.now() - started;
			trace.latencyMs += event.latencyMs;
			trace.events.push(event);
		}
	}

	private recordTrace(trace: NormalizedTrace): NormalizedTrace {
		this.traces.push(trace);
		return trace;
	}
	private lastScope(): AdapterScope {
		if (!this.lastScopeId) throw new Error("LocalRagAdapter.observe requires a previous scoped operation");
		return { id: this.lastScopeId };
	}
}

export async function runLocalRagLifecycleSmoke(): Promise<LocalRagSmokeResult> {
	const indexRoot = process.env.MEMSWE_LOCALRAG_INDEX_DIR ?? join(RUNS_ROOT, "localrag-index");
	const scope: AdapterScope = { id: `memswe-localrag-smoke-${Date.now()}` };
	const adapter = new LocalRagAdapter({ indexRoot });
	const predicates: Record<string, boolean> = {};
	try {
		await adapter.reset(scope);
		predicates.reset_completed = true;
		// Path-traversal guard (review hardening): a pathological scope id must never sanitize to a
		// dots-only or separator-bearing segment, so reset()/delete() (rm -rf) can never escape indexRoot.
		predicates.sanitize_blocks_traversal = ["..", ".", "...", "../../etc", "a/../b", "/", ""].every((evil) => {
			const s = sanitize(evil);
			return !/^\.*$/.test(s) && !s.includes("/") && !s.includes("\\");
		});
		const content = `MemSWE LocalRAG smoke fact ${scope.id}. The lifecycle marker phrase is retain recall delete. Unrelated distractor sentence about caching.`;
		await adapter.seed([{ scope, operation: "write", content, metadata: { smoke: true } }]);
		predicates.retain_completed = true;
		const retained = await adapter.run({ scope, prompt: `lifecycle marker ${scope.id}` });
		predicates.recall_after_retain = retained.output.includes(scope.id) || retained.output.includes("lifecycle marker");
		await adapter.observe();
		predicates.observe_completed = true;
		await adapter.delete(scope);
		const afterDelete = await adapter.run({ scope, prompt: `lifecycle marker ${scope.id}` });
		predicates.recall_after_delete_empty = afterDelete.output === "[]";
		const exported = await adapter.export();
		return {
			schema_version: "memswe-localrag-smoke.v0.1",
			created_at: new Date().toISOString(),
			index_root: indexRoot,
			scope_id: scope.id,
			status: Object.values(predicates).every(Boolean) ? "passed" : "failed",
			predicate_results: predicates,
			export: exported,
		};
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		const exported = await adapter.export();
		return {
			schema_version: "memswe-localrag-smoke.v0.1",
			created_at: new Date().toISOString(),
			index_root: indexRoot,
			scope_id: scope.id,
			status: "failed",
			predicate_results: predicates,
			export: exported,
			error: { failed_phase: failedPhase(exported), message, guidance: "LocalRAG baseline is local + deterministic; a failure indicates a code/FS bug, not a missing service." },
		};
	}
}

function emptyTrace(scope: AdapterScope): NormalizedTrace {
	return { providerId: PROVIDER_ID, scopeId: scope.id, events: [], latencyMs: 0, injectedMemoryTokens: 0, errors: [], artifacts: [] };
}

function failedPhase(exported: AdapterExport): string {
	const errorTrace = [...exported.traces].reverse().find((trace) => trace.errors.length > 0);
	return errorTrace?.errors.at(-1)?.operation ?? "predicate";
}

async function main(): Promise<void> {
	const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	const artifactsDir = join(RUNS_ROOT, timestamp, "localrag-baseline-smoke");
	await mkdir(artifactsDir, { recursive: true });
	const result = await runLocalRagLifecycleSmoke();
	const resultPath = join(artifactsDir, "localrag-smoke-result.json");
	await writeFile(resultPath, `${JSON.stringify(result, null, "\t")}\n`);
	console.log(`LocalRAG baseline lifecycle smoke ${result.status}`);
	console.log(`Wrote ${relative(REPO_ROOT, resultPath)}`);
	if (result.error) console.log(result.error.guidance);
	if (result.status === "failed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
