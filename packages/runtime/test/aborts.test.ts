import { randomUUID } from "node:crypto";
import { defineTask } from "@earendil-works/pi-durable";
import fc from "fast-check";
import { tokenKey, tokensAt } from "@petrus/petri-net";
import { describe, expect, onTestFinished, test } from "vitest";
import type { Execution, ExecutionInput, HandlerResult, NetInstance } from "../src/index.ts";
import { busyPlaceId, createRuntime, execution } from "../src/index.ts";
import { createCoordination } from "../src/coordination.ts";
import { createNetInstanceCache } from "../src/net-instance-cache.ts";
import type { Disk, Process } from "./disk.ts";
import { context, createClock, createDisk } from "./disk.ts";
import {
	abortedOperations,
	abortFaultProperty,
	cancelled,
	jobsBatch,
	sleepingAbortProperty,
	untilAborted,
	work,
	workHandler,
	workOptions,
} from "./abort-properties.ts";
import { finished, slots } from "./handler-properties.ts";
import { lastState } from "./properties.ts";
import { immediateExecution } from "./native-execution.ts";

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
const withoutAborted = immediateExecution(
	{ ...work, variants: { done: done ?? { value: work.variables.j, outputs: [] } } },
	(_input, signal) => untilAborted(signal),
);

/** A process over a new disk whose clock starts at 5, with jobs j1 and j2 and two slots enqueued at that time. */
async function workingAt5(handler: Execution): Promise<Opened> {
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
function stuckHandler(): Execution & { readonly entered: Promise<void> } {
	let enter = (): void => undefined;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	return {
		...immediateExecution(
			work,
			async (_input, signal) => {
				enter();
				return untilAborted(signal);
			},
			{ variant: "aborted", value: null },
		),
		entered,
	};
}

const never = (): Promise<void> => new Promise(() => undefined);

function workWithChild(mode: "waiting" | "completing"): {
	readonly registered: Execution;
	readonly ready: Promise<undefined>;
	readonly childAborting: Promise<undefined>;
	readonly releaseChild: () => void;
} {
	const childEntered = Promise.withResolvers<undefined>();
	const childAborting = Promise.withResolvers<undefined>();
	const release = Promise.withResolvers<undefined>();
	const ready = Promise.withResolvers<undefined>();
	const child = defineTask<null, { readonly phase: "run" }, null>({
		name: `abort-child:${randomUUID()}`,
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (_task, runtime) => {
				childEntered.resolve(undefined);
				await untilAborted(runtime.signal);
			},
		},
		abort: async (_task, runtime, context) => {
			childAborting.resolve(undefined);
			await release.promise;
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
	const worker = defineTask<ExecutionInput, { readonly phase: "spawn" } | { readonly phase: "choose" }, HandlerResult>(
		{
			name: `abort-parent:${randomUUID()}`,
			version: 1,
			initial: () => ({ phase: "spawn" }),
			phases: {
				spawn: async (_task, runtime, context) => {
					await runtime.commit(async (tx) => {
						const id = await tx.createTask(child, null, { ownership: { kind: "task", taskId: runtime.taskId } });
						return mode === "waiting"
							? { status: "waiting", on: [id], policy: "allSettled", checkpoint: { phase: "choose" } }
							: { status: "running", checkpoint: { phase: "choose" } };
					}, context);
					await childEntered.promise;
					if (mode === "waiting") ready.resolve(undefined);
				},
				choose: async ({ input }, runtime, context) => {
					await runtime.commit(
						() => ({
							status: "terminal",
							outcome: { status: "completed", result: { variant: "done", value: input.binding.j ?? null } },
						}),
						context,
					);
					ready.resolve(undefined);
				},
			},
			abort: async (_task, runtime, context) => {
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "completed", result: { variant: "aborted", value: null } },
					}),
					context,
				);
			},
		},
	);
	const registered = execution(work, worker);
	return {
		registered: { ...registered, extension: { ...registered.extension, tasks: [worker, child] } },
		ready: ready.promise,
		childAborting: childAborting.promise,
		releaseChild: () => {
			release.resolve(undefined);
		},
	};
}

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

	test("aborting before launch creates no worker or result and keeps the reserved binding", async () => {
		const handler = workHandler(never);
		const opened = await workingAt5(handler);
		const { disk, instance } = opened;
		expect(await instance.abort("work/2", context)).toBe("marked");
		await ended(opened, "work/2");
		expect([...abortedOperations(lastState(disk.history()))]).toStrictEqual([]);
		expect(tokensAt(lastState(disk.history()).marking, cancelled.id)).toStrictEqual([]);
		expect(await instance.inFlight(context)).toHaveLength(2);
		expect(tokensAt(lastState(disk.history()).marking, busyPlaceId(work.id))).toContainEqual({ j: "j2", s: "slot" });
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
		expect(await second.inFlight(context)).toHaveLength(1);
		expect(await opened.instance.inFlight(context)).toHaveLength(2);
	});

	test("refuses to abort an operation that has not started, which is a bug in the host", async () => {
		const { instance } = await workingAt5(workHandler(never));
		await expect(instance.abort("work/7", context)).rejects.toThrow("no operation work/7 has started");
	});

	test("host cancellation does not require an aborted variant and leaves a missing result in flight", async () => {
		const opened = await workingAt5(withoutAborted);
		const { instance } = opened;
		expect(await instance.abort("work/1", context)).toBe("marked");
		await ended(opened, "work/1");
		expect(await instance.inFlight(context)).toHaveLength(2);
	});

	test("an aborted variant may have a non-null value chosen by the native task", async () => {
		const entered = Promise.withResolvers<undefined>();
		const handler = immediateExecution(
			{ ...work, variants: { ...work.variants, aborted: { value: work.variables.j, outputs: [] } } },
			(_input, signal) => {
				entered.resolve(undefined);
				return untilAborted(signal);
			},
			{ variant: "aborted", value: "j1" },
		);
		const opened = await workingAt5(handler);
		opened.process.harness.resume();
		await entered.promise;
		const ending = ended(opened, "work/1");
		expect(await opened.instance.abort("work/1", context)).toBe("marked");
		await ending;
		expect([...abortedOperations(lastState(opened.disk.history()))]).toStrictEqual(["work/1"]);
		expect(opened.disk.reports()).toStrictEqual([]);
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
		const run = createCoordination(
			{
				...workOptions(handler, clock),
				cache: createNetInstanceCache(randomUUID()),
				net: runtime.net,
				handlerIds: new Set([work.id]),
			},
			[handler],
		);
		const operations = await instance.inFlight(context);
		const ids = await process.harness.commit(
			(tx) => Promise.all(operations.map((operation) => run.taskOf(tx, conversationId, operation.id))),
			context,
		);
		const { tasks } = await process.harness.inspect(context);
		const inputOf = (id: number): unknown => tasks.find(({ record }) => Number(record.id) === id)?.record.input;
		expect(ids.map((id) => inputOf(Number(id)))).toMatchObject(operations.map(({ id }) => ({ id })));
		await expect(process.harness.commit((tx) => run.taskOf(tx, conversationId, "work/999"), context)).rejects.toThrow(
			"no coordinator runs the operation work/999",
		);
	});
});

describe("aborts, properties", () => {
	test("native results survive work and abort races and crashes; unlaunched cancellations need explicit resolution", async () => {
		await fc.assert(abortFaultProperty(createRuntime));
	});
	test("cancellation before a native sleep deadline preserves the worker's abort result", async () => {
		await fc.assert(sleepingAbortProperty(createRuntime));
	});
});

test.each([
	{ mode: "waiting", chosen: { variant: "aborted", value: null }, resultPlace: cancelled.id },
	{ mode: "completing", chosen: { variant: "done", value: "j1" }, resultPlace: finished.id },
] as const)(
	"cancellation while a worker is $mode holds resources until its child terminates and preserves its chosen result",
	async ({ mode, chosen, resultPlace }) => {
		const family = workWithChild(mode);
		const clock = createClock(5);
		const runtime = createRuntime(workOptions(family.registered, clock));
		const disk = createDisk([runtime.extension], clock);
		const process = await disk.open();
		onTestFinished(async () => {
			family.releaseChild();
			await process.harness.close(context);
		});
		const instance = runtime.instance(process.harness, (await process.harness.root(context)).id);
		await instance.enqueue(jobsBatch(["j1"], 1), context);
		const reserved = await instance.state(context);
		process.harness.resume();
		await family.ready;
		const tasks = (await process.harness.inspect(context)).tasks;
		const worker = tasks.find(({ record }) => record.kind.startsWith("abort-parent:"));
		const child = tasks.find(({ record }) => record.kind.startsWith("abort-child:"));
		if (worker === undefined || child === undefined) throw new Error("the worker did not create its child");
		expect(worker.record.state.status).toBe(mode);
		expect(child.record.owner).toBe(worker.record.id);
		if (mode === "completing") {
			expect(worker.record.state).toStrictEqual({
				status: "completing",
				outcome: { status: "completed", result: chosen },
			});
		}
		expect(await instance.abort("work/1", context)).toBe("marked");
		await family.childAborting;
		expect(await instance.state(context)).toStrictEqual(reserved);
		expect(await instance.inFlight(context)).toHaveLength(1);
		await expect(instance.resolve("work/1", chosen, context)).rejects.toThrow("has not ended");
		expect(await process.harness.getTask(child.record.id, context)).toMatchObject({ state: { status: "running" } });
		family.releaseChild();
		await process.settle();
		expect(await process.harness.getTask(child.record.id, context)).toMatchObject({ state: { status: "terminal" } });
		expect(await process.harness.getTask(worker.record.id, context)).toMatchObject({
			state: { status: "terminal", outcome: { status: "completed", result: chosen } },
		});
		expect((await instance.state(context)).marking).toStrictEqual({
			[slots.id]: ["slot"],
			[resultPlace]: ["j1"],
		});
		expect(await instance.inFlight(context)).toStrictEqual([]);
		expect(disk.reports()).toStrictEqual([]);
	},
);
