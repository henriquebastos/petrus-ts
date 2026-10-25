import fc from "fast-check";
import type { Token } from "@petrus/petri-net";
import { tokensAt } from "@petrus/petri-net";
import { describe, expect, onTestFinished, test } from "vitest";
import type { Handler, NetInstance } from "../src/index.ts";
import { createRuntime } from "../src/index.ts";
import { BrokenNetInstance } from "../src/net-instance.ts";
import { netInstanceRecord } from "../src/net-instance-record.ts";
import { otherNet } from "./broken-instance.ts";
import type { Disk, Process } from "./disk.ts";
import { context, createClock, createDisk } from "./disk.ts";
import {
	delayFaultProperty,
	elapsedAfter,
	reminded,
	reminderHandler,
	remindersOptions,
	remindTransition,
	requested,
} from "./delay-properties.ts";
import { lastState } from "./properties.ts";

type Opened = { readonly disk: Disk; readonly process: Process; readonly instance: NetInstance };

/** A process over a new disk whose clock starts at 5, with reminder r1 enqueued at that time. */
async function remindedAt5(handler: Handler): Promise<Opened> {
	const clock = createClock(5);
	const runtime = createRuntime(remindersOptions(handler, clock));
	const disk = createDisk([runtime.extension], clock);
	const process = await disk.open();
	onTestFinished(() => process.harness.close(context));
	const instance = runtime.instance(process.harness, (await process.harness.root(context)).id);
	await instance.enqueue({ requestId: "first", tokens: { [requested.id]: ["r1"] } }, context);
	return { disk, process, instance };
}

/** The time at which the log holds the result of the operation `remind/1`, or undefined when it holds none. */
function resultTime(disk: Disk): number | undefined {
	return lastState(disk.history()).log.find(
		(entry) => entry.kind === "ingress" && entry.requestId === "result:remind/1",
	)?.at;
}

describe("delayed results", () => {
	test("a result delayed 10 ms counts at the time of its start plus 10, and not before", async () => {
		const { disk, process, instance } = await remindedAt5(reminderHandler((r) => elapsedAfter(r, 10)));
		await process.runReady();
		expect(await instance.inFlight(context)).toHaveLength(1);
		expect(process.harness.wake().at).toBe(15);
		expect(resultTime(disk)).toBeUndefined();
		await process.settle();
		expect(resultTime(disk)).toBe(15);
		expect(tokensAt(lastState(disk.history()).marking, reminded.id)).toStrictEqual(["r1"]);
		expect(await instance.inFlight(context)).toStrictEqual([]);
	});

	test("a result delayed 0 ms counts at the time of its start", async () => {
		const { disk, process } = await remindedAt5(reminderHandler((r) => elapsedAfter(r, 0)));
		await process.runReady();
		expect(resultTime(disk)).toBe(5);
		expect(disk.reports()).toStrictEqual([]);
	});

	test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
		"a delay of %d ms is a bug in the handler: it is reported, and the handler runs again after retryDelayMs",
		async (bad) => {
			const handler = reminderHandler((r, run) => elapsedAfter(r, run === 1 ? bad : 10));
			const { disk, process } = await remindedAt5(handler);
			await process.settle();
			expect(disk.reports()).toMatchObject([
				{
					name: "RangeError",
					message: `a delay must be a finite number of milliseconds, at least 0, not ${String(bad)}`,
				},
			]);
			expect(handler.runs()).toBe(2);
			// The second run is at 6, after retryDelayMs, but the delay counts from the start at 5.
			expect(resultTime(disk)).toBe(15);
		},
	);

	test("a delayed result that does not fit the transition is reported before the task sleeps, and the handler runs again", async () => {
		const handler = reminderHandler((r, run) => ({
			delayMs: 10,
			result: { variant: run === 1 ? "early" : "elapsed", value: r },
		}));
		const { disk, process } = await remindedAt5(handler);
		await process.settle();
		const [report, ...more] = disk.reports();
		expect(more).toStrictEqual([]);
		expect(() => {
			throw report;
		}).toThrow(/^invalid batch result:remind\/1: /);
		expect(handler.runs()).toBe(2);
		expect(resultTime(disk)).toBe(15);
	});

	test("a throw in the commit of a due result is reported, and the result commits after retryDelayMs, with no new run of the handler", async () => {
		let throws = 1;
		const transition = remindTransition((value): readonly Token[] => {
			if (throws > 0) {
				throws -= 1;
				throw new Error("the end's arc failed once");
			}
			return [value];
		});
		const handler = reminderHandler((r) => elapsedAfter(r, 10), transition);
		const { disk, process } = await remindedAt5(handler);
		await process.settle();
		expect(disk.reports()).toMatchObject([{ message: "the end's arc failed once" }]);
		expect(handler.runs()).toBe(1);
		expect(resultTime(disk)).toBe(16);
	});

	test("a broken net instance in the commit of a due result ends the task faulted, reported once, with no new run of the handler", async () => {
		const handler = reminderHandler((r) => elapsedAfter(r, 10));
		const { disk, process } = await remindedAt5(handler);
		await process.runReady();
		const [task] = (await process.harness.inspect(context)).tasks;
		if (task === undefined) {
			throw new Error("the enqueue created no task");
		}
		const root = await process.harness.root(context);
		await process.harness.commit(async (tx) => {
			otherNet(await tx.doc(netInstanceRecord, root.id));
		}, context);
		await process.settle();
		await process.harness.waitForIdle(context);
		expect(disk.reports()).toStrictEqual([
			new BrokenNetInstance("the conversation holds an instance of the net other, not reminders"),
		]);
		expect((await process.harness.getTask(task.record.id, context))?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "faulted" },
		});
		expect(handler.runs()).toBe(1);
		expect(resultTime(disk)).toBeUndefined();
	});

	test("aborting a sleeping task ends it as aborted, and its result never counts", async () => {
		const { disk, process, instance } = await remindedAt5(reminderHandler((r) => elapsedAfter(r, 10)));
		await process.runReady();
		const [task] = (await process.harness.inspect(context)).tasks;
		if (task === undefined) {
			throw new Error("the enqueue created no task");
		}
		expect(await process.harness.abortTask(task.record.id, context)).toBe("marked");
		await process.settle();
		expect((await process.harness.getTask(task.record.id, context))?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "aborted" },
		});
		expect(resultTime(disk)).toBeUndefined();
		expect(await instance.inFlight(context)).toHaveLength(1);
	});
});

describe("delayed results, properties", () => {
	test("each delayed result counts once and on time when a crash cuts any commit", async () => {
		await fc.assert(delayFaultProperty(createRuntime));
	});
});
