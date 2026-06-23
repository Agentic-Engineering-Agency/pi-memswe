import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import {
	compareSessionIds,
	sessionIndex,
	type TaskYaml,
	validFactsBeforeSession,
} from "../../scripts/memswe-smoke-runner-lib.ts";

const CODING_AGENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PI_ROOT = resolve(CODING_AGENT_ROOT, "../..");
const MEMSWE_ROOT = resolve(PI_ROOT, "../memswe");

describe("memswe per-session valid fact selection", () => {
	test("includes only facts valid before each multi-session prompt", async () => {
		const gamma = await readTaskYaml("repo-gamma-invoice-export-001");
		const delta = await readTaskYaml("repo-delta-billing-url-001");

		expect(sessionIndex("s3")).toBe(3);
		expect(compareSessionIds("s2", "s3")).toBeLessThan(0);
		expect(compareSessionIds("s4", "s3")).toBeGreaterThan(0);

		expect(validFactIds(gamma, "s1")).toEqual([]);
		expect(validFactIds(gamma, "s2")).toEqual([]);
		expect(validFactIds(gamma, "s3")).toEqual([
			"new-csv-columns-customer-id-currency",
			"new-sort-created-at-descending",
			"preserve-public-endpoint-path",
		]);

		expect(validFactIds(delta, "s1")).toEqual([]);
		expect(validFactIds(delta, "s2")).toEqual([]);
		expect(validFactIds(delta, "s4")).toEqual(["billing-url-prod"]);
	});
});

async function readTaskYaml(taskId: string): Promise<TaskYaml> {
	const content = await readFile(join(MEMSWE_ROOT, "tasks", taskId, "task.yaml"), "utf8");
	return parse(content) as TaskYaml;
}

function validFactIds(task: TaskYaml, sessionId: string): string[] {
	return validFactsBeforeSession(task, sessionId).map((fact) => fact.id ?? "");
}
