import fc from "fast-check";
import { expect, test } from "vitest";
import { crashCutProperty, raceProperty } from "../../packages/runtime/test/properties.ts";
import { createRacyRuntime } from "../../fixtures/simulation/racy-runtime.ts";
import { createSplitCommitRuntime } from "../../fixtures/simulation/split-commit-runtime.ts";

test("the scheduler finds the interleaving where a racy runtime loses an acknowledged step", async () => {
	const result = await fc.check(raceProperty(createRacyRuntime));
	expect(result.failed).toBe(true);
});

test("a crash cut finds the runtime that splits one step across two commits", async () => {
	const result = await fc.check(crashCutProperty(createSplitCommitRuntime));
	expect(result.failed).toBe(true);
});
