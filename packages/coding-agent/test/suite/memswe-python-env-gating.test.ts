import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { preparePythonEnvironment, type TaskYaml } from "../../scripts/memswe-smoke-runner-lib.ts";

const CODING_AGENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PI_ROOT = resolve(CODING_AGENT_ROOT, "../..");
const MEMSWE_ROOT = resolve(PI_ROOT, "../memswe");

describe("memswe Python environment gating", () => {
	test("skips venv for TypeScript tasks and keeps it for Python tasks", async () => {
		const alpha = parse(
			await readFile(join(MEMSWE_ROOT, "tasks", "repo-alpha-convention-newsletter-001", "task.yaml"), "utf8"),
		) as TaskYaml;
		const gamma = parse(
			await readFile(join(MEMSWE_ROOT, "tasks", "repo-gamma-invoice-export-001", "task.yaml"), "utf8"),
		) as TaskYaml;
		const alphaWorkdir = await mkdtemp(join(tmpdir(), "memswe-alpha-env-test-"));
		const gammaWorkdir = await mkdtemp(join(tmpdir(), "memswe-gamma-env-test-"));
		try {
			const alphaEnv = await preparePythonEnvironment(alphaWorkdir, alpha);

			expect(alphaEnv).toEqual({ shimDir: "", setupResult: undefined });
			await expect(pathExists(join(alphaWorkdir, ".memswe-venv"))).resolves.toBe(false);

			const gammaWithoutSetup: TaskYaml = {
				...gamma,
				harbor: {
					...gamma.harbor,
					environment: { ...gamma.harbor?.environment, setup_command: undefined },
				},
			};
			const gammaEnv = await preparePythonEnvironment(gammaWorkdir, gammaWithoutSetup);

			expect(gammaEnv.shimDir).toBe(join(gammaWorkdir, ".memswe-venv/bin"));
			expect(gammaEnv.setupResult).toBeUndefined();
			await expect(pathExists(join(gammaWorkdir, ".memswe-venv"))).resolves.toBe(true);
		} finally {
			await rm(alphaWorkdir, { recursive: true, force: true });
			await rm(gammaWorkdir, { recursive: true, force: true });
		}
	});
});


async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}
