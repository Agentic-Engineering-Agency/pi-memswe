import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SECRET_ENV_NAME_PATTERN, scrubSecretEnv } from "../../scripts/memswe-smoke-runner-lib.ts";

// Vars the harness must NEVER expose to a verifier command or the task-author
// setup_command subprocess (F11). All are name-matched by SECRET_ENV_NAME_PATTERN.
const SECRET_VARS: Record<string, string> = {
	MINIMAX_API_KEY: "sk-minimax-xxx",
	HINDSIGHT_API_LLM_API_KEY: "hs-xxx",
	LANGFUSE_SECRET_KEY: "lf-secret",
	LANGFUSE_PUBLIC_KEY: "lf-public",
	OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
	GITHUB_TOKEN: "ghp_xxx",
	DB_PASSWORD: "hunter2",
	AWS_SESSION_TOKEN: "aws-xxx",
	SOME_CREDENTIAL: "cred",
};

// Benign vars a subprocess legitimately needs and must keep seeing.
const SAFE_VARS: Record<string, string> = {
	HOME: "/home/runner",
	LANG: "en_US.UTF-8",
	CI: "1",
};

describe("scrubSecretEnv (F11: harness secrets never reach verifier/setup subprocesses)", () => {
	const saved: Record<string, string | undefined> = {};
	const touched = [...Object.keys(SECRET_VARS), ...Object.keys(SAFE_VARS), "PATH"];

	beforeEach(() => {
		for (const k of touched) saved[k] = process.env[k];
		for (const [k, v] of Object.entries(SECRET_VARS)) process.env[k] = v;
		for (const [k, v] of Object.entries(SAFE_VARS)) process.env[k] = v;
	});

	afterEach(() => {
		for (const k of touched) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	test("drops every secret-named var", () => {
		const env = scrubSecretEnv();
		for (const k of Object.keys(SECRET_VARS)) {
			expect(env[k], `${k} must be scrubbed`).toBeUndefined();
		}
	});

	test("keeps benign, non-secret vars", () => {
		const env = scrubSecretEnv();
		for (const [k, v] of Object.entries(SAFE_VARS)) {
			expect(env[k]).toBe(v);
		}
	});

	test("prepends the given dir to PATH and preserves the rest", () => {
		process.env.PATH = "/usr/bin:/bin";
		const env = scrubSecretEnv("/work/.memswe-venv/bin");
		expect(env.PATH).toBe("/work/.memswe-venv/bin:/usr/bin:/bin");
	});

	test("leaves PATH unprefixed when no dir is given", () => {
		process.env.PATH = "/usr/bin:/bin";
		const env = scrubSecretEnv();
		expect(env.PATH).toBe("/usr/bin:/bin");
	});

	test("pattern matches credential names but not benign names", () => {
		for (const name of Object.keys(SECRET_VARS)) {
			expect(SECRET_ENV_NAME_PATTERN.test(name), `${name} should match`).toBe(true);
		}
		for (const name of ["HOME", "LANG", "PATH", "CI"]) {
			expect(SECRET_ENV_NAME_PATTERN.test(name), `${name} should NOT match`).toBe(false);
		}
	});
});
