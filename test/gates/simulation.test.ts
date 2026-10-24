import fc from "fast-check";
import { expect, test } from "vitest";
import { crashCutProperty, raceProperty, retryProperty } from "../../packages/runtime/test/properties.ts";
import { handlerFaultProperty, handlerRaceProperty } from "../../packages/runtime/test/handler-properties.ts";
import { createEarlyStartRuntime } from "../../fixtures/simulation/early-start-runtime.ts";
import { createForgetfulSettleRuntime } from "../../fixtures/simulation/forgetful-settle-runtime.ts";
import { createPerCallSettleRuntime } from "../../fixtures/simulation/per-call-settle-runtime.ts";
import { createStickyFailureRuntime } from "../../fixtures/simulation/sticky-failure-runtime.ts";
import { createTimedResultRuntime } from "../../fixtures/simulation/timed-result-runtime.ts";
import { createEarlyReleaseRuntime } from "../../fixtures/simulation/early-release-runtime.ts";
import { createForgetfulRuntime } from "../../fixtures/simulation/forgetful-runtime.ts";
import { createIdBlindRuntime } from "../../fixtures/simulation/id-blind-runtime.ts";
import { createMemoryIdsRuntime } from "../../fixtures/simulation/memory-ids-runtime.ts";
import { createRacyRuntime } from "../../fixtures/simulation/racy-runtime.ts";
import { createSplitCommitRuntime } from "../../fixtures/simulation/split-commit-runtime.ts";
import { createUnqueuedEnqueueRuntime } from "../../fixtures/simulation/unqueued-enqueue-runtime.ts";

/** The property itself said "inconsistent", so a crash in the harness cannot pass for a found defect. */
const propertyVerdict = "Error: Property failed by returning false";

test("the scheduler finds the interleaving where a racy runtime loses an acknowledged step", async () => {
	const result = await fc.check(raceProperty(createRacyRuntime, []));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("the scheduler finds the runtime that starts the next step before the commit lands", async () => {
	const result = await fc.check(raceProperty(createEarlyReleaseRuntime, []));
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

test("a lost reply finds the runtime that adds a retried batch twice", async () => {
	const result = await fc.check(retryProperty(createIdBlindRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("the scheduler finds the runtime whose enqueue does not wait for the steps", async () => {
	const result = await fc.check(raceProperty(createUnqueuedEnqueueRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("a failed commit or a retry on a new runtime finds the runtime that keeps request ids in memory", async () => {
	const result = await fc.check(retryProperty(createMemoryIdsRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("a crash with work in flight finds the runtime whose settle forgets the operations it did not start", async () => {
	const result = await fc.check(handlerFaultProperty(createForgetfulSettleRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("the fault property finds the runtime that runs a handler before the step that starts it is stored", async () => {
	const result = await fc.check(handlerFaultProperty(createEarlyStartRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("the scheduler finds the runtime whose concurrent settles run one operation twice", async () => {
	const result = await fc.check(handlerRaceProperty(createPerCallSettleRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("the fault property finds the runtime that records a result under a request id that is not the operation's", async () => {
	const result = await fc.check(handlerFaultProperty(createTimedResultRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("the outage finds the runtime that never runs an operation again after its handler threw", async () => {
	const result = await fc.check(handlerFaultProperty(createStickyFailureRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});
