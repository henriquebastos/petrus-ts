import fc from "fast-check";
import { expect, test } from "vitest";
import { crashCutProperty, raceProperty } from "../../packages/runtime/test/properties.ts";
import { createEarlyReleaseRuntime } from "../../fixtures/simulation/early-release-runtime.ts";
import { createForgetfulRuntime } from "../../fixtures/simulation/forgetful-runtime.ts";
import { createRacyRuntime } from "../../fixtures/simulation/racy-runtime.ts";
import { createSplitCommitRuntime } from "../../fixtures/simulation/split-commit-runtime.ts";

/** The property itself said "inconsistent", so a crash in the harness cannot pass for a found defect. */
const propertyVerdict = "Error: Property failed by returning false";

test("the scheduler finds the interleaving where a racy runtime loses an acknowledged step", async () => {
	const result = await fc.check(raceProperty(createRacyRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("the scheduler finds the runtime that starts the next step before the commit lands", async () => {
	const result = await fc.check(raceProperty(createEarlyReleaseRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("a crash cut finds the runtime that splits one step across two commits", async () => {
	const result = await fc.check(crashCutProperty(createSplitCommitRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("the crash-cut property finds the runtime that acknowledges steps but never commits them", async () => {
	const result = await fc.check(crashCutProperty(createForgetfulRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});
