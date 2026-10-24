import fc from "fast-check";
import { expect, test } from "vitest";
import { crashProperty, raceProperty } from "../../packages/runtime/test/properties.ts";
import { handlerFaultProperty } from "../../packages/runtime/test/handler-properties.ts";
import { delayFaultProperty } from "../../packages/runtime/test/delay-properties.ts";
import { createEarlyDueRuntime } from "../../fixtures/simulation/early-due-runtime.ts";
import { createLostDueRuntime } from "../../fixtures/simulation/lost-due-runtime.ts";
import { createFromRunRuntime } from "../../fixtures/simulation/from-run-runtime.ts";
import { createEarlyStartRuntime } from "../../fixtures/simulation/early-start-runtime.ts";
import { createForgetfulRuntime } from "../../fixtures/simulation/forgetful-runtime.ts";
import { createIdBlindRuntime } from "../../fixtures/simulation/id-blind-runtime.ts";
import { createLateTaskRuntime } from "../../fixtures/simulation/late-task-runtime.ts";
import { createSplitCommitRuntime } from "../../fixtures/simulation/split-commit-runtime.ts";
import { createStaleReadRuntime } from "../../fixtures/simulation/stale-read-runtime.ts";
import { createTimedResultRuntime } from "../../fixtures/simulation/timed-result-runtime.ts";
import { createUncaughtThrowRuntime } from "../../fixtures/simulation/uncaught-throw-runtime.ts";

/** The property itself said "inconsistent", so a crash in the harness cannot pass for a found defect. */
const propertyVerdict = "Error: Property failed by returning false";

test("the crash property finds the runtime that acknowledges batches but never writes them", async () => {
	const result = await fc.check(crashProperty(createForgetfulRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("the crash property finds the runtime that admits a batch and steps the net in two commits", async () => {
	const result = await fc.check(crashProperty(createSplitCommitRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("the crash property finds the runtime that adds a batch sent again after a crash twice", async () => {
	const result = await fc.check(crashProperty(createIdBlindRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("the scheduler finds the runtime that commits a change made from a read outside the commit", async () => {
	const result = await fc.check(raceProperty(createStaleReadRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("the fault property finds the runtime that runs a handler before the commit that starts it lands", async () => {
	const result = await fc.check(handlerFaultProperty(createEarlyStartRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("a crash finds the runtime that creates the tasks of new operations in a second commit", async () => {
	const result = await fc.check(handlerFaultProperty(createLateTaskRuntime));
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

test("the outage finds the runtime whose handler task ends faulted when its handler throws", async () => {
	const result = await fc.check(handlerFaultProperty(createUncaughtThrowRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("the delay property finds the runtime that records a delayed result at once", async () => {
	const result = await fc.check(delayFaultProperty(createEarlyDueRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("the delay property finds the runtime whose due phase ends the task without the result", async () => {
	const result = await fc.check(delayFaultProperty(createLostDueRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});

test("an outage after a crash finds the runtime that counts a delay from the handler's run", async () => {
	const result = await fc.check(delayFaultProperty(createFromRunRuntime));
	expect({ failed: result.failed, reason: String(result.errorInstance) }).toStrictEqual({
		failed: true,
		reason: propertyVerdict,
	});
});
