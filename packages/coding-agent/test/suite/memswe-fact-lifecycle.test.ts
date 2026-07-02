import { describe, expect, test } from "vitest";
import {
	compareSessionIds,
	type FactSpec,
	sessionIndex,
	type TaskYaml,
	validFactsBeforeSession,
} from "../../scripts/memswe-smoke-runner-lib.ts";

// These cover the fact-lifecycle filtering branches in validFactsBeforeSession
// and the numeric session ordering that fixture-based tests do not exercise.
// They use synthetic tasks so each branch is asserted directly (no FS, no mocks).

function task(introduce: FactSpec[]): TaskYaml {
	return { memswe: { facts: { introduce } } } as TaskYaml;
}

function ids(t: TaskYaml, sessionId: string): string[] {
	return validFactsBeforeSession(t, sessionId).map((f) => f.id ?? "");
}

describe("session id ordering", () => {
	test("orders numerically, not lexically (s9 < s10 < s100)", () => {
		// Lexical comparison would wrongly rank "s10" < "s9". sessionIndex must be numeric.
		expect(sessionIndex("s9")).toBe(9);
		expect(sessionIndex("s10")).toBe(10);
		expect(sessionIndex("s100")).toBe(100);
		expect(compareSessionIds("s9", "s10")).toBeLessThan(0);
		expect(compareSessionIds("s10", "s9")).toBeGreaterThan(0);
		expect(compareSessionIds("s100", "s10")).toBeGreaterThan(0);
	});

	test("undefined left compares as future; malformed id sorts last", () => {
		// compareSessionIds(undefined, x) === 1 keeps facts with no first_valid_session eligible.
		expect(compareSessionIds(undefined, "s1")).toBe(1);
		// Number("X") -> NaN -> POSITIVE_INFINITY, so a malformed id never reads as "before" anything.
		expect(sessionIndex("sX")).toBe(Number.POSITIVE_INFINITY);
		expect(compareSessionIds("sX", "s999")).toBeGreaterThan(0);
	});
});

describe("validFactsBeforeSession lifecycle filtering", () => {
	test("first_valid_session: fact is excluded at and before introduction, included strictly after", () => {
		const t = task([{ id: "f1", text: "alpha", first_valid_session: "s2" }]);
		expect(ids(t, "s1")).toEqual([]); // before introduction
		expect(ids(t, "s2")).toEqual([]); // introduced this session, not yet recallable
		expect(ids(t, "s3")).toEqual(["f1"]); // available afterwards
		expect(ids(t, "s10")).toEqual(["f1"]); // still valid much later (numeric, not lexical)
	});

	test("invalid_after_session: fact drops out once the session passes its validity window", () => {
		const t = task([{ id: "f1", text: "stale-able", first_valid_session: "s1", invalid_after_session: "s3" }]);
		expect(ids(t, "s2")).toEqual(["f1"]); // valid within window
		expect(ids(t, "s3")).toEqual(["f1"]); // boundary: still valid at invalid_after session
		expect(ids(t, "s4")).toEqual([]); // expired after the window
	});

	test("forget_requested_session: fact is excluded in sessions after the forget request", () => {
		const t = task([{ id: "f1", text: "forgettable", first_valid_session: "s1", forget_requested_session: "s2" }]);
		expect(ids(t, "s2")).toEqual(["f1"]); // boundary: still present at forget session
		expect(ids(t, "s3")).toEqual([]); // gone afterwards
	});

	test("forbidden facts and text-less facts are never returned", () => {
		const t = task([
			{ id: "forbidden", text: "do-not-use", expected_use: "forbidden", first_valid_session: "s1" },
			{ id: "empty", first_valid_session: "s1" },
			{ id: "ok", text: "keep", first_valid_session: "s1" },
		]);
		expect(ids(t, "s5")).toEqual(["ok"]);
	});

	test("empty/absent introduce list yields no facts", () => {
		expect(validFactsBeforeSession({} as TaskYaml, "s3")).toEqual([]);
		expect(ids(task([]), "s3")).toEqual([]);
	});
});
