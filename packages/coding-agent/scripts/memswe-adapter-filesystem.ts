#!/usr/bin/env -S npx tsx

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

// Repository-docs / filesystem baseline (AMB-7). The canonical inspectable project-memory baseline
// every vendor AMS is compared against: prior-session facts are written as Markdown docs under a
// per-scope directory, and recall is deterministic lexical retrieval over those docs. NO external
// service, NO credentials — fully local + deterministic, so the lifecycle smoke PASSES (not skips).
//
// Reset is a file-tree cleanup per scope (rm -rf <scopeDir>), so each repetition is isolated. The
// caller seeds only memory-eligible facts — hidden/protected verifier content must never be seeded
// (harness responsibility; this provider stores exactly what it is given).
//
// Distinct from the LocalRAG baseline (AMB-67): repository_docs injects whole matching docs;
// LocalRAG chunks + scores. Mirrors the AmsAdapter contract used by the vendor adapters.

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const RUNS_ROOT = join(REPO_ROOT, ".memswe-runs");
const PROVIDER_ID = "filesystem";
const DEFAULT_TOP_K = 5;

type FilesystemAdapterOptions = {
	/** Root dir for per-scope doc stores. Defaults to <repo>/.memswe-runs/fs-memory (override for isolation). */
	memoryRoot?: string;
	topK?: number;
};

type FilesystemSmokeResult = {
	schema_version: "memswe-filesystem-smoke.v0.1";
	created_at: string;
	memory_root: string;
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
	// Map any char outside the safe set to "_" — this already collapses "/" and "\" so the result is
	// a single path segment (no separators). The remaining traversal risk is a DOTS-ONLY segment
	// ("", ".", ".."), which would resolve to cwd or memoryRoot's PARENT and let reset()/delete()
	// rm -rf OUTSIDE memoryRoot — so map any dots-only id to a safe token.
	const cleaned = id.replace(/[^a-zA-Z0-9_.-]/g, "_");
	return /^\.*$/.test(cleaned) ? "_scope_" : cleaned;
}

/** Lexical overlap score: how many distinct query terms appear in the doc (case-insensitive). */
function scoreDoc(query: string, content: string): number {
	const haystack = content.toLowerCase();
	const terms = new Set(query.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
	let score = 0;
	for (const term of terms) if (haystack.includes(term)) score += 1;
	return score;
}

export class FilesystemAdapter implements AmsAdapter {
	private readonly memoryRoot: string;
	private readonly topK: number;
	private readonly traces: NormalizedTrace[] = [];
	private readonly artifacts: NormalizedArtifact[] = [];
	private lastScopeId?: string;

	constructor(options: FilesystemAdapterOptions = {}) {
		this.memoryRoot = options.memoryRoot ?? join(RUNS_ROOT, "fs-memory");
		this.topK = options.topK ?? DEFAULT_TOP_K;
	}

	private scopeDir(scope: AdapterScope): string {
		const dir = join(this.memoryRoot, sanitize(scope.id));
		// Defense-in-depth: the resolved scope dir MUST stay within memoryRoot, so reset()/delete()
		// (rm -rf) can never escape it even if sanitize is ever weakened.
		const root = resolve(this.memoryRoot);
		const resolved = resolve(dir);
		if (resolved !== root && !resolved.startsWith(root + sep)) {
			throw new Error(`FilesystemAdapter: scope ${JSON.stringify(scope.id)} escapes memoryRoot`);
		}
		return dir;
	}

	async reset(scope: AdapterScope): Promise<NormalizedTrace> {
		const trace = emptyTrace(scope);
		await this.capture(trace, "delete", scope, `reset ${this.rel(scope)}`, async () => {
			await rm(this.scopeDir(scope), { recursive: true, force: true });
			await mkdir(this.scopeDir(scope), { recursive: true });
			return "ok";
		});
		this.lastScopeId = scope.id;
		return this.recordTrace(trace);
	}

	async seed(events: AdapterSeedEvent[]): Promise<NormalizedTrace> {
		if (events.length === 0) throw new Error("FilesystemAdapter.seed requires at least one event");
		const firstScope = events[0]?.scope;
		if (!firstScope) throw new Error("FilesystemAdapter.seed requires scoped events");
		const trace = emptyTrace(firstScope);
		await mkdir(this.scopeDir(firstScope), { recursive: true });
		let index = 0;
		for (const event of events) {
			if (event.scope.id !== firstScope.id) throw new Error("FilesystemAdapter.seed received mixed scopes");
			const docId = event.providerId ?? `doc-${String(index).padStart(3, "0")}`;
			const docPath = join(this.scopeDir(event.scope), `${sanitize(docId)}.md`);
			await this.capture(trace, "write", event.scope, event.content, async () => {
				await writeFile(docPath, event.content);
				return relative(REPO_ROOT, docPath);
			}, docId);
			index += 1;
		}
		this.lastScopeId = firstScope.id;
		return this.recordTrace(trace);
	}

	async run(input: AdapterRunInput): Promise<AdapterRunResult> {
		const trace = emptyTrace(input.scope);
		const output = await this.capture(trace, "retrieve", input.scope, input.prompt, async () => {
			const dir = this.scopeDir(input.scope);
			const files = (await safeReaddir(dir)).filter((f) => f.endsWith(".md"));
			const scored = await Promise.all(
				files.map(async (file) => {
					const path = join(dir, file);
					const content = await readFile(path, "utf8");
					return { path: relative(REPO_ROOT, path), score: scoreDoc(input.prompt, content), tokens: approxTokens(content), content };
				}),
			);
			const matched = scored.filter((d) => d.score > 0).sort((a, b) => b.score - a.score).slice(0, this.topK);
			const injected = matched.length > 0 ? matched : scored.sort((a, b) => b.tokens - a.tokens).slice(0, this.topK);
			return JSON.stringify(injected);
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
		await this.capture(trace, "retrieve", scope, `list ${this.rel(scope)}`, async () => {
			const files = (await safeReaddir(this.scopeDir(scope))).filter((f) => f.endsWith(".md"));
			return JSON.stringify(files);
		});
		return this.recordTrace(trace);
	}

	async delete(scope: AdapterScope): Promise<NormalizedTrace> {
		const trace = emptyTrace(scope);
		await this.capture(trace, "delete", scope, `delete ${this.rel(scope)}`, async () => {
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
		memoryId?: string,
	): Promise<string> {
		const started = Date.now();
		const event: NormalizedTraceEvent = { operation, providerId: PROVIDER_ID, scopeId: scope.id, input, memoryId, metadata: {} };
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

	private rel(scope: AdapterScope): string {
		return relative(REPO_ROOT, this.scopeDir(scope));
	}

	private recordTrace(trace: NormalizedTrace): NormalizedTrace {
		this.traces.push(trace);
		return trace;
	}

	private lastScope(): AdapterScope {
		if (!this.lastScopeId) throw new Error("FilesystemAdapter.observe requires a previous scoped operation");
		return { id: this.lastScopeId };
	}
}

export async function runFilesystemLifecycleSmoke(): Promise<FilesystemSmokeResult> {
	const memoryRoot = process.env.MEMSWE_FS_MEMORY_DIR ?? join(RUNS_ROOT, "fs-memory");
	const scope: AdapterScope = { id: `memswe-filesystem-smoke-${Date.now()}` };
	const adapter = new FilesystemAdapter({ memoryRoot });
	const predicates: Record<string, boolean> = {};
	try {
		await adapter.reset(scope);
		predicates.reset_completed = true;
		// Path-traversal guard (review hardening): a pathological scope id must never sanitize to a
		// dots-only or separator-bearing segment, so reset()/delete() (rm -rf) can never escape memoryRoot.
		predicates.sanitize_blocks_traversal = ["..", ".", "...", "../../etc", "a/../b", "/", ""].every((evil) => {
			const s = sanitize(evil);
			return !/^\.*$/.test(s) && !s.includes("/") && !s.includes("\\");
		});
		const content = `MemSWE filesystem smoke fact ${scope.id}: retain recall delete lifecycle marker.`;
		await adapter.seed([{ scope, operation: "write", content, metadata: { smoke: true } }]);
		predicates.retain_completed = true;
		const retained = await adapter.run({ scope, prompt: `Find lifecycle marker for ${scope.id}` });
		predicates.recall_after_retain = retained.output.includes(scope.id) && retained.output.includes("lifecycle marker");
		await adapter.observe();
		predicates.observe_completed = true;
		await adapter.delete(scope);
		const afterDelete = await adapter.run({ scope, prompt: `Find lifecycle marker for ${scope.id}` });
		predicates.recall_after_delete_empty = !afterDelete.output.includes(scope.id);
		const exported = await adapter.export();
		return {
			schema_version: "memswe-filesystem-smoke.v0.1",
			created_at: new Date().toISOString(),
			memory_root: memoryRoot,
			scope_id: scope.id,
			status: Object.values(predicates).every(Boolean) ? "passed" : "failed",
			predicate_results: predicates,
			export: exported,
		};
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		const exported = await adapter.export();
		return {
			schema_version: "memswe-filesystem-smoke.v0.1",
			created_at: new Date().toISOString(),
			memory_root: memoryRoot,
			scope_id: scope.id,
			status: "failed",
			predicate_results: predicates,
			export: exported,
			error: { failed_phase: failedPhase(exported), message, guidance: "Filesystem baseline is local; a failure indicates a code/FS-permission bug, not a missing service." },
		};
	}
}

function emptyTrace(scope: AdapterScope): NormalizedTrace {
	return { providerId: PROVIDER_ID, scopeId: scope.id, events: [], latencyMs: 0, injectedMemoryTokens: 0, errors: [], artifacts: [] };
}

async function safeReaddir(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

function failedPhase(exported: AdapterExport): string {
	const errorTrace = [...exported.traces].reverse().find((trace) => trace.errors.length > 0);
	return errorTrace?.errors.at(-1)?.operation ?? "predicate";
}

async function main(): Promise<void> {
	const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
	const artifactsDir = join(RUNS_ROOT, timestamp, "filesystem-baseline-smoke");
	await mkdir(artifactsDir, { recursive: true });
	const result = await runFilesystemLifecycleSmoke();
	const resultPath = join(artifactsDir, "filesystem-smoke-result.json");
	await writeFile(resultPath, `${JSON.stringify(result, null, "\t")}\n`);
	console.log(`Filesystem baseline lifecycle smoke ${result.status}`);
	console.log(`Wrote ${relative(REPO_ROOT, resultPath)}`);
	if (result.error) console.log(result.error.guidance);
	if (result.status === "failed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
