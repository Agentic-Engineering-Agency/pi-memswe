import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { parse } from "yaml";
import { summarizeRunRecordForReport } from "../../scripts/memswe-report-generator.ts";
import { classifyPrimaryFailureCategory, resolveRunSessionId, scoreReward } from "../../scripts/memswe-smoke-runner.ts";
import {
	discoverTaskIds,
	inferVerifierAssets,
	initializeWorktreeBaseline,
	preparePythonEnvironment,
	type TaskYaml,
	validateRunRecordAgainstSchema,
	validateRunRecordShape,
	writePatchArtifacts,
} from "../../scripts/memswe-smoke-runner-lib.ts";
import {
	createDisabledMemSweTrace,
	createEnabledMemSweTrace,
	memoryLatencySummary,
	traceCompletenessSummary,
} from "../../scripts/memswe-trace-scaffold.ts";

const CODING_AGENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PI_ROOT = resolve(CODING_AGENT_ROOT, "../..");
const MEMSWE_ROOT = resolve(PI_ROOT, "../memswe");

describe("memswe smoke runner Python environment", () => {
	test("creates an isolated venv and runs setup commands inside it", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "memswe-env-test-"));
		try {
			const task: TaskYaml = {
				harbor: {
					environment: {
						setup_command:
							"python -c 'import pathlib, sys; pathlib.Path(\"venv-prefix.txt\").write_text(sys.prefix)'",
					},
				},
			};
			const env = await preparePythonEnvironment(workdir, task);
			const prefix = await readFile(join(workdir, "venv-prefix.txt"), "utf8");

			expect(prefix).toContain(".memswe-venv");
			expect(env.shimDir).toContain(".memswe-venv");
			expect(env.setupResult?.exit_code).toBe(0);
		} finally {
			await rm(workdir, { recursive: true, force: true });
		}
	});
});

describe("memswe smoke runner verifier assets", () => {
	test("infers gamma visible and protected verifier assets without hidden assets by default", async () => {
		const taskDir = join(MEMSWE_ROOT, "tasks/repo-gamma-invoice-export-001");
		const workdir = join(tmpdir(), "memswe-asset-test");
		const task = parse(await readFile(join(taskDir, "task.yaml"), "utf8")) as TaskYaml;
		const assets = inferVerifierAssets(taskDir, workdir, task, false);
		const destinations = assets.map((asset) => asset.destination);

		expect(destinations).toContain(join(workdir, "tests/test_invoice_export_visible.py"));
		expect(destinations).toContain(join(workdir, "tests/test_invoice_export_protected.py"));
		expect(destinations).toContain(join(workdir, "tests/conftest.py"));
		expect(destinations).not.toContain(join(workdir, "tests/test_invoice_export_hidden.py"));
		expect(assets.every((asset) => asset.destination.startsWith(join(workdir, "tests")))).toBe(true);
	});

	test("includes hidden verifier assets only when requested", async () => {
		const taskDir = join(MEMSWE_ROOT, "tasks/repo-gamma-invoice-export-001");
		const workdir = join(tmpdir(), "memswe-asset-test");
		const task = parse(await readFile(join(taskDir, "task.yaml"), "utf8")) as TaskYaml;
		const assets = inferVerifierAssets(taskDir, workdir, task, true);

		expect(assets.map((asset) => asset.destination)).toContain(join(workdir, "tests/test_invoice_export_hidden.py"));
	});
});

describe("memswe smoke runner patch artifacts", () => {
	test("emits stable empty no-op patch artifacts", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "memswe-patch-test-work-"));
		const artifactsDir = await mkdtemp(join(tmpdir(), "memswe-patch-test-artifacts-"));
		try {
			await writeFile(join(workdir, "example.txt"), "baseline\n");
			await mkdir(join(workdir, "src"));
			await writeFile(join(workdir, "src/module.txt"), "module\n");
			await initializeWorktreeBaseline(workdir);

			const artifacts = await writePatchArtifacts(workdir, artifactsDir);

			expect(await readFile(artifacts.agentPatch, "utf8")).toBe("");
			expect(await readFile(artifacts.worktreeDiff, "utf8")).toBe("");
			expect(JSON.parse(await readFile(artifacts.changedFiles, "utf8"))).toEqual([]);
		} finally {
			await rm(workdir, { recursive: true, force: true });
			await rm(artifactsDir, { recursive: true, force: true });
		}
	});
});

describe("memswe smoke runner run-record validation", () => {
	test("accepts the required run-record shape", () => {
		expect(() => validateRunRecordShape(validRunRecord())).not.toThrow();
	});

	test("rejects missing required run-record fields", () => {
		const record = validRunRecord();
		delete record.condition.condition_id;

		expect(() => validateRunRecordShape(record)).toThrow("Missing condition_id");
	});

	test("accepts records that conform to the canonical run-record schema", () => {
		expect(() =>
			validateRunRecordAgainstSchema(
				validSchemaRunRecord(),
				resolve(MEMSWE_ROOT, "schema", "run-record.schema.json"),
			),
		).not.toThrow();
	});

	test("rejects records missing schema-required metric_vector", () => {
		const record: Partial<ReturnType<typeof validSchemaRunRecord>> = validSchemaRunRecord();
		delete record.metric_vector;

		expect(() =>
			validateRunRecordAgainstSchema(record, resolve(MEMSWE_ROOT, "schema", "run-record.schema.json")),
		).toThrow("Run record violates run-record.schema.json");
	});
});

describe("memswe smoke runner scoring", () => {
	test("treats reward as not evaluable until every hidden f2p verifier passes", () => {
		expect(
			scoreReward([
				{ kind: "hidden", f2p: true, p2p: false, exit_code: 1 },
				{ kind: "protected", f2p: false, p2p: true, exit_code: 0 },
			]),
		).toBeUndefined();
		expect(
			scoreReward([
				{ kind: "visible", f2p: false, p2p: false, exit_code: 0 },
				{ kind: "protected", f2p: false, p2p: true, exit_code: 0 },
			]),
		).toBeUndefined();
	});

	test("emits reward only when all hidden f2p verifiers pass", () => {
		expect(
			scoreReward([
				{ kind: "hidden", f2p: true, p2p: false, exit_code: 0 },
				{ kind: "protected", f2p: false, p2p: true, exit_code: 0 },
			]),
		).toMatchObject({
			reward: 1,
			f2p_total: 1,
			f2p_passed: 1,
			p2p_total: 1,
			p2p_passed: 1,
		});
	});
});

describe("memswe smoke runner session fallback", () => {
	test("falls back to the per-task graded session including zeta s4", () => {
		expect(
			resolveRunSessionId({
				memswe: {
					session_sequence: [
						{ session_id: "s1", prompt_ref: "sessions/s1.md" },
						{ session_id: "s4", prompt_ref: "sessions/s4.md", graded: true },
					],
				},
			}),
		).toBe("s4");
	});

	test("classifies agent errors as process failures", () => {
		expect(classifyPrimaryFailureCategory({ status: "errored" }, false)).toBe("process_failure");
		expect(classifyPrimaryFailureCategory({ status: "completed" }, false)).toBe("task_failure");
		expect(classifyPrimaryFailureCategory({ status: "completed" }, true)).toBeNull();
	});
});

describe("memswe report generator run summary", () => {
	test("parses not-evaluable rewards and failure categories", () => {
		expect(
			summarizeRunRecordForReport({
				reward: undefined,
				primary_failure_category: "process_failure",
				session_results: [{ session_id: "s4", status: "errored" }],
			}),
		).toEqual({
			reward: null,
			primaryFailureCategory: "process_failure",
			sessionId: "s4",
			status: "errored",
		});
	});
});

describe("memswe OTel trace scaffold", () => {
	test("stays inert unless trace flag is enabled", () => {
		const trace = createDisabledMemSweTrace("run-1");

		const span = trace.startSpan("benchmark", "benchmark.run");
		span.end();

		expect(trace.enabled).toBe(false);
		expect(trace.traceId).toBeNull();
		expect(trace.toArtifact()).toEqual({ enabled: false });
		expect(traceCompletenessSummary(trace.toArtifact())).toEqual({
			complete: false,
			missingKinds: ["benchmark", "memory", "verifier", "scoring"],
			traceCoverage: 0,
		});
	});

	test("records sanitized benchmark memory verifier and scoring spans", () => {
		const trace = createEnabledMemSweTrace("memswe-smoke-task-2026", 1000);

		trace.startSpan("benchmark", "benchmark.run", { task_id: "task-1", secret: "sk-nope" }, 1000).end(1010);
		trace.startSpan("memory", "memory.prepare", { condition_id: "repository_docs" }, 1000).end(1020);
		trace.startSpan("verifier", "verifier.visible", { verifier_id: "visible-1" }, 1000).end(1035);
		trace.startSpan("scoring", "scoring.reward", { reward_evaluable: true }, 1000).end(1040);

		const artifact = trace.toArtifact();
		if (!artifact.enabled) throw new Error("Expected enabled trace artifact");

		expect(artifact.trace_id).toBe("memswe-smoke-task-2026");
		expect(artifact.trace_store_ref).toBe("memswe-trace://memswe-smoke-task-2026");
		expect(artifact.spans.map((span) => span.kind)).toEqual(["benchmark", "memory", "verifier", "scoring"]);
		expect(artifact.spans.map((span) => span.duration_ms)).toEqual([10, 20, 35, 40]);
		expect(artifact.spans[0]?.attributes).toEqual({ task_id: "task-1" });
		expect(traceCompletenessSummary(artifact)).toEqual({
			complete: true,
			missingKinds: [],
			traceCoverage: 1,
		});
		expect(memoryLatencySummary(artifact)).toEqual({ p50_ms: 20, p95_ms: 20 });
	});

	test("adds Langfuse Basic auth to OTLP exports", async () => {
		const originalFetch = globalThis.fetch;
		const originalLangfuseEndpoint = process.env.LANGFUSE_OTLP_ENDPOINT;
		const originalOtelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		const originalPublicKey = process.env.LANGFUSE_PUBLIC_KEY;
		const originalSecretKey = process.env.LANGFUSE_SECRET_KEY;
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));

		process.env.LANGFUSE_OTLP_ENDPOINT = "https://cloud.langfuse.com/api/public/otel";
		delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
		process.env.LANGFUSE_SECRET_KEY = "sk-test";
		globalThis.fetch = fetchMock;

		try {
			const trace = createEnabledMemSweTrace("run-auth", 1000);
			trace.startSpan("benchmark", "benchmark.run", {}, 1000).end(1010);

			await trace.flush();

			const firstCall = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0];
			if (!firstCall) throw new Error("Expected OTLP fetch call");
			expect(firstCall[0]).toBe("https://cloud.langfuse.com/api/public/otel/v1/traces");
			expect((firstCall[1] as RequestInit).headers).toEqual({
				authorization: `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`,
				"content-type": "application/json",
				"memswe-otlp-endpoint-source": "LANGFUSE_OTLP_ENDPOINT",
			});
			const artifact = trace.toArtifact();
			if (!artifact.enabled) throw new Error("Expected enabled trace artifact");
			expect(artifact.trace_store_ref).toBe("memswe-trace://run-auth");
		} finally {
			globalThis.fetch = originalFetch;
			restoreEnv("LANGFUSE_OTLP_ENDPOINT", originalLangfuseEndpoint);
			restoreEnv("OTEL_EXPORTER_OTLP_ENDPOINT", originalOtelEndpoint);
			restoreEnv("LANGFUSE_PUBLIC_KEY", originalPublicKey);
			restoreEnv("LANGFUSE_SECRET_KEY", originalSecretKey);
		}
	});

	test("skips OTLP export when endpoint env is unset", async () => {
		const originalFetch = globalThis.fetch;
		const originalLangfuseEndpoint = process.env.LANGFUSE_OTLP_ENDPOINT;
		const originalOtelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		const originalPublicKey = process.env.LANGFUSE_PUBLIC_KEY;
		const originalSecretKey = process.env.LANGFUSE_SECRET_KEY;
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));

		delete process.env.LANGFUSE_OTLP_ENDPOINT;
		delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
		process.env.LANGFUSE_SECRET_KEY = "sk-test";
		globalThis.fetch = fetchMock;

		try {
			const trace = createEnabledMemSweTrace("run-no-endpoint", 1000);
			trace.startSpan("benchmark", "benchmark.run", {}, 1000).end(1010);

			await expect(trace.flush()).resolves.toEqual({ status: "skipped", reason: "endpoint_unset" });
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
			restoreEnv("LANGFUSE_OTLP_ENDPOINT", originalLangfuseEndpoint);
			restoreEnv("OTEL_EXPORTER_OTLP_ENDPOINT", originalOtelEndpoint);
			restoreEnv("LANGFUSE_PUBLIC_KEY", originalPublicKey);
			restoreEnv("LANGFUSE_SECRET_KEY", originalSecretKey);
		}
	});
});

describe("memswe smoke runner task discovery", () => {
	test("discovers only directories with task.yaml, sorted by task id", async () => {
		const root = await mkdtemp(join(tmpdir(), "memswe-discover-test-"));
		try {
			const tasksRoot = join(root, "tasks");
			await mkdir(join(tasksRoot, "repo-zeta-001"), { recursive: true });
			await writeFile(join(tasksRoot, "repo-zeta-001", "task.yaml"), "id: repo-zeta-001\n");
			await mkdir(join(tasksRoot, "repo-alpha-001"), { recursive: true });
			await writeFile(join(tasksRoot, "repo-alpha-001", "task.yaml"), "id: repo-alpha-001\n");
			await mkdir(join(tasksRoot, "no-descriptor"), { recursive: true });
			await writeFile(join(tasksRoot, "README.md"), "not a task\n");
			await expect(discoverTaskIds(root)).resolves.toEqual(["repo-alpha-001", "repo-zeta-001"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("discovers the live memswe catalog non-empty and sorted", async () => {
		const taskIds = await discoverTaskIds(MEMSWE_ROOT);
		expect(taskIds.length).toBeGreaterThan(0);
		expect(taskIds).toEqual([...taskIds].sort());
		expect(new Set(taskIds).size).toBe(taskIds.length);
	});
});

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = value;
}

function validRunRecord(): {
	schema_version: string;
	run_id: string;
	task_id: string;
	condition: { condition_id?: string };
	session_results: Array<{ session_id: string }>;
	output_locations: { artifacts_dir: string };
} {
	return {
		schema_version: "uam-run.v0.1",
		run_id: "run-1",
		task_id: "task-1",
		condition: { condition_id: "no_memory" },
		session_results: [{ session_id: "s1" }],
		output_locations: { artifacts_dir: "/tmp/artifacts" },
	};
}

function validSchemaRunRecord() {
	return {
		schema_version: "uam-run.v0.1",
		run_id: "run-1",
		task_id: "task-1",
		condition: {
			condition_id: "no_memory",
			model_id: "faux-text",
			repetition_index: 1,
			k: 1,
		},
		session_results: [
			{
				session_id: "s1",
				status: "completed",
				trace_id: "trace-1",
			},
		],
		metric_vector: {},
		output_locations: {
			trace_store_ref: "trace-store://run-1",
			artifacts_dir: "/tmp/artifacts",
		},
	};
}
