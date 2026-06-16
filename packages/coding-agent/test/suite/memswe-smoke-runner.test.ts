import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import {
	inferVerifierAssets,
	initializeWorktreeBaseline,
	preparePythonEnvironment,
	type TaskYaml,
	writePatchArtifacts,
} from "../../scripts/memswe-smoke-runner-lib.ts";

const CODING_AGENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PI_ROOT = resolve(CODING_AGENT_ROOT, "../..");
const MEMSWE_ROOT = resolve(PI_ROOT, "../memswe");

describe("memswe smoke runner Python environment", () => {
	test("creates an isolated venv and runs setup commands inside it", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "memswe-env-test-"));
		try {
			const env = await preparePythonEnvironment(
				workdir,
				"python -c 'import pathlib, sys; pathlib.Path(\"venv-prefix.txt\").write_text(sys.prefix)'",
			);
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
