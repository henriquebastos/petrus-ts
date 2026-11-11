import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { tokenKey, tokensAt } from "@petrus/petri-net";
import { describe, expect, onTestFinished, test } from "vitest";
import type { Handler, NetInstance } from "../src/index.ts";
import { busyPlaceId, createRuntime, withHandlers } from "../src/index.ts";
import { createOperationRun } from "../src/operation-run.ts";
import { createNetInstanceCache } from "../src/net-instance-cache.ts";
import type { Disk, Process } from "./disk.ts";
import { context, createClock, createDisk } from "./disk.ts";
import {
	abortedOperations,
	abortFaultProperty,
	cancelled,
	jobsBatch,
	untilAborted,
	work,
	workHandler,
	workOptions,
} from "./abort-properties.ts";
import { finished, slots } from "./handler-properties.ts";
import { lastState } from "./properties.ts";

type Opened = { readonly disk: Disk; readonly process: Process; readonly instance: NetInstance };

/** Waits until the task of the operation `operationId` has ended. */
async function ended({ process }: Opened, operationId: string): Promise<void> {
	const { tasks } = await process.harness.inspect(context);
	const task = tasks.find(({ record }) => tokenKey(record.input).includes(`"id":"${operationId}"`));
	if (task === undefined) {
		throw new Error(`no live task runs ${operationId}`);
	}
	await process.harness.waitForTask(task.record.id, context);
}

/** The variants of `work` without `aborted`. */
const { done } = work.variants;
const withoutAborted: Handler = {
	transition: { ...work, variants: { done: done ?? { value: work.variables.j, outputs: [] } } },
	run: (_binding, { signal }) => untilAborted(signal),
};

/** A process over a new disk whose clock starts at 5, with jobs j1 and j2 and two slots enqueued at that time. */
async function workingAt5(handler: Handler): Promise<Opened> {
	const clock = createClock(5);
	const runtime = createRuntime(workOptions(handler, clock));
	const disk = createDisk([runtime.extension], clock);
	const process = await disk.open();
	onTestFinished(() => process.harness.close(context));
	const instance = runtime.instance(process.harness, (await process.harness.root(context)).id);
	await instance.enqueue(jobsBatch(["j1", "j2"], 2), context);
	return { disk, process, instance };
}

/** A handler that never ends by itself: it waits for its signal. `entered` resolves when a run begins. */
function stuckHandler(): Handler & { readonly entered: Promise<void> } {
	let enter = (): void => undefined;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	return {
		transition: work,
		run: async (_binding, { signal }) => {
			enter();
			return untilAborted(signal);
		},
		entered,
	};
}

const never = (): Promise<void> => new Promise(() => undefined);

describe("aborts", () => {
	test("aborting an operation whose handler runs stops the handler through its signal, records the result aborted once, and gives the slot back", async () => {
		const handler = stuckHandler();
		const opened = await workingAt5(handler);
		const { disk, process, instance } = opened;
		process.harness.resume();
		await handler.entered;
		const ending = ended(opened, "work/1");
		expect(await instance.abort("work/1", context)).toBe("marked");
		await ending;
		const final = lastState(disk.history());
		expect([...abortedOperations(final)]).toStrictEqual(["work/1"]);
		const results = final.log.filter((entry) => entry.kind === "ingress" && entry.requestId === "result:work/1");
		expect(results).toHaveLength(1);
		expect(final.log.at(-1)).toMatchObject({ kind: "occurrence", transition: "work:aborted", at: 5 });
		expect(tokensAt(final.marking, cancelled.id)).toStrictEqual(["j1"]);
		expect(tokensAt(final.marking, slots.id)).toStrictEqual(["slot"]);
		expect(await instance.inFlight(context)).toHaveLength(1);
		expect(disk.reports()).toStrictEqual([]);
	});

	test("aborting an operation before its task runs records aborted, and the handler never runs", async () => {
		const handler = workHandler(never);
		const opened = await workingAt5(handler);
		const { disk, instance } = opened;
		expect(await instance.abort("work/2", context)).toBe("marked");
		await ended(opened, "work/2");
		expect([...abortedOperations(lastState(disk.history()))]).toStrictEqual(["work/2"]);
		expect(tokensAt(lastState(disk.history()).marking, cancelled.id)).toStrictEqual(["j2"]);
		expect(handler.ran()).not.toContain("work/2");
	});

	test("aborting a sleeping operation records aborted, not its delayed result", async () => {
		const handler = workHandler(() => Promise.resolve(), new Map([["j1", 10]]));
		const { disk, process, instance } = await workingAt5(handler);
		await process.runReady();
		expect(await instance.inFlight(context)).toHaveLength(1);
		expect(await instance.abort("work/1", context)).toBe("marked");
		await process.settle();
		const final = lastState(disk.history());
		expect([...abortedOperations(final)]).toStrictEqual(["work/1"]);
		expect(tokensAt(final.marking, finished.id)).toStrictEqual(["j2"]);
		expect(tokensAt(final.marking, cancelled.id)).toStrictEqual(["j1"]);
		expect(final.log.at(-1)?.at).toBe(5);
	});

	test("aborting an operation that has ended returns terminal and changes nothing", async () => {
		const { disk, process, instance } = await workingAt5(workHandler(() => Promise.resolve()));
		await process.runReady();
		const before = lastState(disk.history());
		expect(await instance.abort("work/1", context)).toBe("terminal");
		await process.runReady();
		expect(lastState(disk.history())).toStrictEqual(before);
		expect(tokensAt(before.marking, finished.id)).toStrictEqual(["j1", "j2"]);
	});

	test("aborts only the operation of its own net instance, when another conversation has an operation with the same id", async () => {
		const handler = workHandler(never);
		const opened = await workingAt5(handler);
		const { disk, process } = opened;
		const runtime = createRuntime(workOptions(handler, disk.clock));
		const other = await process.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const second = runtime.instance(process.harness, other.id);
		await second.enqueue(jobsBatch(["j1"], 1), context);
		const { tasks } = await process.harness.inspect(context);
		const task = tasks.find(({ record }) => record.conversationId === other.id);
		if (task === undefined) {
			throw new Error("the second enqueue created no task");
		}
		expect(await second.abort("work/1", context)).toBe("marked");
		const marked = (await process.harness.inspect(context)).tasks.filter(({ record }) => record.abortRequested);
		expect(marked.map(({ record }) => record.id)).toStrictEqual([task.record.id]);
		await process.harness.waitForTask(task.record.id, context);
		expect(await second.inFlight(context)).toStrictEqual([]);
		expect(await opened.instance.inFlight(context)).toHaveLength(2);
	});

	test("refuses to abort an operation that has not started, which is a bug in the host", async () => {
		const { instance } = await workingAt5(workHandler(never));
		await expect(instance.abort("work/7", context)).rejects.toThrow("no operation work/7 has started");
	});

	test("refuses to abort an operation whose transition declares no variant aborted, which would keep its tokens", async () => {
		const { instance } = await workingAt5(withoutAborted);
		await expect(instance.abort("work/1", context)).rejects.toThrow(
			"work declares no variant aborted, so its tokens would stay taken",
		);
	});

	test("refuses an aborted variant whose colour set does not hold null, which is a bug in the net", () => {
		const handler: Handler = {
			transition: { ...work, variants: { ...work.variants, aborted: { value: work.variables.j, outputs: [] } } },
			run: () => Promise.resolve({ variant: "done", value: "j1" }),
		};
		expect(() => createRuntime(workOptions(handler, createClock()))).toThrow(
			"invalid net: work: the colour set of the variant aborted must hold null",
		);
	});

	test("an aborted task of a transition with no variant aborted ends with nothing recorded, and its tokens stay taken", async () => {
		const opened = await workingAt5(withoutAborted);
		const { disk, process } = opened;
		const [task] = (await process.harness.inspect(context)).tasks;
		if (task === undefined) {
			throw new Error("the enqueue created no task");
		}
		expect(await process.harness.abortTask(task.record.id, context)).toBe("marked");
		await process.harness.waitForTask(task.record.id, context);
		expect(abortedOperations(lastState(disk.history())).size).toBe(0);
		expect(tokensAt(lastState(disk.history()).marking, busyPlaceId(work.id))).toHaveLength(2);
	});

	test("finds the task of each of 101 operations, across pages of task records, and refuses an operation with none", async () => {
		const jobs = Array.from({ length: 101 }, (_, index) => `j${String(index)}`);
		const clock = createClock();
		const handler = workHandler(never);
		const runtime = createRuntime(workOptions(handler, clock));
		const disk = createDisk([runtime.extension], clock);
		const process = await disk.open();
		onTestFinished(() => process.harness.close(context));
		const conversationId = (await process.harness.root(context)).id;
		const instance = runtime.instance(process.harness, conversationId);
		await instance.enqueue(jobsBatch(jobs, 101), context);
		const run = createOperationRun({
			...workOptions(handler, clock),
			cache: createNetInstanceCache(randomUUID()),
			net: withHandlers(workOptions(handler, clock).net, [work]),
			handlerIds: new Set([work.id]),
			handlers: [handler],
		});
		const operations = await instance.inFlight(context);
		const ids = await process.harness.commit(
			(tx) => Promise.all(operations.map((operation) => run.taskOf(tx, conversationId, operation.id))),
			context,
		);
		const { tasks } = await process.harness.inspect(context);
		const inputOf = (id: number): unknown => tasks.find(({ record }) => Number(record.id) === id)?.record.input;
		expect(ids.map((id) => inputOf(Number(id)))).toMatchObject(operations.map(({ id }) => ({ id })));
		await expect(process.harness.commit((tx) => run.taskOf(tx, conversationId, "work/999"), context)).rejects.toThrow(
			"no task runs the operation work/999",
		);
	});
});

describe("aborts, properties", () => {
	test("every job ends once and each marked abort ends its operation aborted, under any order of work and aborts and a crash at any commit", async () => {
		await fc.assert(abortFaultProperty(createRuntime));
	});
});
