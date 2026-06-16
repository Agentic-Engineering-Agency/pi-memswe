import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { preparePythonEnvironment } from "../../scripts/memswe-smoke-runner-lib.ts";

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
