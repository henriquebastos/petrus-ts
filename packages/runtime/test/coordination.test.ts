import { randomUUID } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { StorageWrite, TaskId, TaskOutcome, Tx } from "@earendil-works/pi-durable";
import { defineTask, MemoryStorage } from "@earendil-works/pi-durable";
import { definitionOrder, placeId, transitionId } from "@petrus/petri-net";
import type { Net, Transition } from "@petrus/petri-net";
import { expect, onTestFinished, test } from "vitest";
import fc from "fast-check";
import type { ExecutionInput, HandlerResult, HandlerTransition, NetInstanceHost, Runtime } from "../src/index.ts";
import { createRuntime, execution } from "../src/index.ts";
import { netInstanceRecord } from "../src/net-instance-record.ts";
import { context, createClock, createDisk, enqueueAndSettle, inProcess } from "./disk.ts";
import type { Disk, Faults, Process, TestClock } from "./disk.ts";
import { replay } from "./replay.ts";

const text = { name: "Text", contains: (value: unknown): value is string => typeof value === "string" };
const input = { id: placeId("input"), colourSet: text };
const output = { id: placeId("output"), colourSet: text };
const transition: HandlerTransition<"job"> = {
	id: transitionId("work"),
	variables: { job: text },
	guard: () => true,
	inputs: [{ place: input, variables: ["job"] }],
	variants: { done: { value: text, outputs: [{ place: output, expression: ({ job }) => [job] }] } },
};
const batch = { requestId: "first", tokens: { [input.id]: ["A"] } };
const answer: HandlerResult = { variant: "done", value: "receipt" };

function native(clock: TestClock, outcome: () => TaskOutcome<HandlerResult>, startLimit = 10): Runtime {
	const task = defineTask<ExecutionInput, { readonly phase: "wait" } | { readonly phase: "finish" }, HandlerResult>({
		name: "native-test.worker",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: ({ input: operation }, runtime, callContext) =>
				runtime.sleepUntil(operation.startedAt + 10, { phase: "finish" }, callContext),
			finish: (_running, runtime, callContext) =>
				runtime.commit(() => ({ status: "terminal", outcome: outcome() }), callContext),
		},
		abort: (_running, runtime, callContext) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext),
	});
	return createRuntime({
		name: "native-test",
		nonce: randomUUID(),
		clock,
		policy: definitionOrder,
		startLimit,
		net: { places: [input, output], transitions: [] },
		executions: [execution(transition, task)],
	});
}

async function opened(
	runtime: Runtime,
	disk: Disk,
): Promise<{
	readonly process: Awaited<ReturnType<Disk["open"]>>;
	readonly instance: ReturnType<Runtime["instance"]>;
}> {
	const process = await disk.open();
	onTestFinished(() => process.harness.close(context));
	const instance = runtime.instance(process.harness, (await process.harness.root(context)).id);
	return { process, instance };
}

class RecordedStorage extends MemoryStorage {
	readonly writes: StorageWrite[] = [];

	override commit(writes: readonly StorageWrite[], callContext: Context): ReturnType<MemoryStorage["commit"]> {
		this.writes.push(...writes);
		return super.commit(writes, callContext);
	}
}

function family(fault: boolean): { readonly runtime: Runtime; readonly disk: Disk; readonly clock: TestClock } {
	const clock = createClock();
	const child = defineTask<number, { readonly phase: "sleep" | "finish" }, null>({
		name: "family.child",
		version: 1,
		initial: () => ({ phase: "sleep" }),
		phases: {
			sleep: ({ input: delay }, rt, ctx) => rt.sleepUntil(rt.now() + delay, { phase: "finish" }, ctx),
			finish: (_task, rt, ctx) =>
				rt.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
		},
		abort: (_task, rt, ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
	const worker = defineTask<ExecutionInput, { readonly phase: "spawn" | "finish" }, HandlerResult>({
		name: "family.worker",
		version: 1,
		initial: () => ({ phase: "spawn" }),
		phases: {
			spawn: (task, rt, ctx) =>
				rt.commit(async (tx) => {
					const children: TaskId<null>[] = [];
					for (const delay of [7, 23])
						children.push(await tx.createTask(child, delay, { ownership: { kind: "task", taskId: task.id } }));
					return fault
						? { status: "sleeping", until: 1, checkpoint: { phase: "finish" } }
						: { status: "waiting", on: children, policy: "allSettled", checkpoint: { phase: "finish" } };
				}, ctx),
			finish: (_task, rt, ctx) => {
				if (fault) throw new Error("worker failed with live children");
				return rt.commit(() => ({ status: "terminal", outcome: { status: "completed", result: answer } }), ctx);
			},
		},
		abort: (_task, rt, ctx) =>
			rt.commit(
				() => ({
					status: "terminal",
					outcome: { status: "aborted", result: { variant: "done", value: "cancelled" } },
				}),
				ctx,
			),
	});
	const runtime = createRuntime({
		name: "family",
		nonce: randomUUID(),
		clock,
		policy: definitionOrder,
		startLimit: 1,
		net: { places: [input, output], transitions: [] },
		executions: [execution(transition, worker)],
	});
	const disk = createDisk([{ ...runtime.extension, tasks: [...(runtime.extension.tasks ?? []), child] }], clock);
	return { runtime, disk, clock };
}

test("cancellation with owned children survives a crash before or after every cancellation commit", async () => {
	async function run(faults?: Faults): Promise<number> {
		const { runtime, disk } = family(false);
		await inProcess(disk, {}, async ({ harness, runReady }) => {
			const instance = runtime.instance(harness, (await harness.root(context)).id);
			await instance.enqueue(batch, context);
			await runReady();
			const children = await harness.commit((tx) => tx.scanTasks({ kind: "family.child" }, 10), context);
			expect(children.items.map((task) => task.state.status)).toStrictEqual(["sleeping", "sleeping"]);
			await expect(instance.resolve("work/1", answer, context)).rejects.toThrow("coordinator");
		});
		let commits = 0;
		async function cancel({ harness, settle }: Process): Promise<void> {
			harness.subscribeCommits(() => {
				commits += 1;
			});
			const instance = runtime.instance(harness, (await harness.root(context)).id);
			await instance.abort("work/1", context);
			await settle();
			const { marking, log } = await instance.state(context);
			expect(marking).toStrictEqual({ output: ["A"] });
			expect(log.filter((entry) => entry.kind === "ingress" && entry.requestId === "result:work/1")).toStrictEqual([
				expect.objectContaining({
					tokens: { "work:result": [{ binding: { job: "A" }, variant: "done", value: "cancelled" }] },
				}),
			]);
			expect(await instance.inFlight(context)).toStrictEqual([]);
			const records = await harness.commit((tx) => tx.scanTasks({}, 10), context);
			expect(records.items).toHaveLength(4);
			for (const task of records.items)
				expect(task.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
		}
		const result = await inProcess(disk, faults ?? {}, cancel);
		if (faults !== undefined) {
			expect(result).toBe("crashed");
			await inProcess(disk, {}, cancel);
		}
		for (const state of disk.history()) expect(replay(runtime.net, {}, state.log)).toStrictEqual(state.marking);
		return commits;
	}
	const commits = await run();
	expect(commits).toBeGreaterThan(0);
	for (let index = 0; index < commits; index++) {
		await run({ crashAtCommit: index });
		await run({ crashAfterCommit: index });
	}
});

test("a worker fault aborts its live children and retains the binding until explicit resolution", async () => {
	const { runtime, disk, clock } = family(true);
	await inProcess(disk, {}, async ({ harness, runReady, settle }) => {
		const instance = runtime.instance(harness, (await harness.root(context)).id);
		await instance.enqueue(batch, context);
		await runReady();
		const children = await harness.commit((tx) => tx.scanTasks({ kind: "family.child" }, 10), context);
		expect(children.items.map((task) => task.state.status)).toStrictEqual(["sleeping", "sleeping"]);
		await expect(instance.resolve("work/1", answer, context)).rejects.toThrow("coordinator");
		clock.moveTo(1);
		await settle();
		const records = await harness.commit((tx) => tx.scanTasks({}, 10), context);
		expect(records.items).toHaveLength(4);
		expect(records.items.every((task) => task.state.status === "terminal")).toBe(true);
		for (const child of children.items) {
			expect((await harness.getTask(child.id, context))?.state).toMatchObject({
				status: "terminal",
				outcome: { status: "aborted" },
			});
		}
		expect(records.items.find((task) => task.kind === "family.worker")?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "faulted", error: { message: "worker failed with live children" } },
		});
		expect(disk.reports()).toHaveLength(1);
		expect(await instance.inFlight(context)).toHaveLength(1);
		expect((await instance.state(context)).marking).toStrictEqual({ "work:busy": [{ job: "A" }] });
		await instance.resolve("work/1", answer, context);
		await instance.resolve("work/1", answer, context);
		expect((await instance.state(context)).marking).toStrictEqual({ output: ["A"] });
		expect(await instance.inFlight(context)).toStrictEqual([]);
	});
});

test("allocation creates one coordinator, launch creates one owned execution, and resolve refuses live coordination", async () => {
	const clock = createClock();
	const runtime = native(clock, () => ({ status: "completed", result: answer }));
	const storage = new RecordedStorage();
	const disk = createDisk([runtime.extension], clock, storage);
	const { process, instance } = await opened(runtime, disk);
	await Promise.all([instance.enqueue(batch, context), instance.enqueue(batch, context)]);
	expect((await instance.state(context)).marking).toStrictEqual({ "work:busy": [{ job: "A" }] });
	expect(await instance.budget(context)).toStrictEqual({ ceiling: 10, used: 1, paused: false });
	await process.runReady();
	const records = await process.harness.commit((tx) => tx.scanTasks({}, 100), context);
	expect(records.items).toHaveLength(2);
	const coordinator = records.items.find((record) => record.owner === undefined);
	const worker = records.items.find((record) => record.owner !== undefined);
	expect(coordinator?.state.status).toBe("waiting");
	expect(worker).toMatchObject({ owner: coordinator?.id, state: { status: "sleeping", until: 10 } });
	const receipt = storage.writes.find(
		(write) => write.type === "document.create" && write.record.kind === "petrus.native-launch",
	);
	if (receipt?.type !== "document.create") throw new Error("allocation must persist its receipt");
	expect(
		storage.writes.flatMap((write) =>
			write.type === "document.change" && write.id === receipt.record.id ? [write.content.kind] : [],
		),
	).toStrictEqual(["delta"]);
	await expect(instance.resolve("work/1", answer, context)).rejects.toThrow("coordinator");
	await process.settle();
	expect((await instance.state(context)).marking).toStrictEqual({ output: ["A"] });
	expect(await instance.inFlight(context)).toStrictEqual([]);
	expect(disk.reports()).toStrictEqual([]);
});

const outcomes: readonly TaskOutcome<HandlerResult>[] = [
	{ status: "completed", result: answer },
	{ status: "failed", error: { message: "expected failure" }, result: answer },
	{ status: "aborted", result: answer },
];

test.each(outcomes)("a declared result in a native $status outcome settles once", async (outcome) => {
	const clock = createClock();
	let calls = 0;
	const runtime = native(clock, () => {
		calls += 1;
		return outcome;
	});
	const disk = createDisk([runtime.extension], clock);
	const { process, instance } = await opened(runtime, disk);
	await instance.enqueue(batch, context);
	await process.settle();
	expect((await instance.state(context)).marking).toStrictEqual({ output: ["A"] });
	const before = await instance.state(context);
	await instance.resolve("work/1", answer, context);
	expect(await instance.state(context)).toStrictEqual(before);
	expect(calls).toBe(1);
});

test("pre-launch cancellation creates no worker and requires an explicit result to release its binding", async () => {
	const clock = createClock();
	let calls = 0;
	const runtime = native(clock, () => {
		calls += 1;
		return { status: "completed", result: answer };
	});
	const disk = createDisk([runtime.extension], clock);
	const { process, instance } = await opened(runtime, disk);
	await instance.enqueue(batch, context);
	expect(await instance.abort("work/1", context)).toBe("marked");
	await process.settle();
	expect(calls).toBe(0);
	expect((await process.harness.commit((tx) => tx.scanTasks({}, 100), context)).items).toHaveLength(1);
	expect((await instance.state(context)).marking).toStrictEqual({ "work:busy": [{ job: "A" }] });
	await instance.resolve("work/1", answer, context);
	expect((await instance.state(context)).marking).toStrictEqual({ output: ["A"] });
});

test.each(["throw", "missing", "invalid", "orphaned"] as const)(
	"native %s results retain inputs without repeating execution",
	async (failure) => {
		const clock = createClock();
		let calls = 0;
		const runtime = native(clock, () => {
			calls += 1;
			if (failure === "throw") throw new Error("native failure");
			if (failure === "orphaned") return { status: "orphaned", reason: "definition unavailable" };
			return failure === "missing"
				? { status: "aborted" }
				: { status: "completed", result: { variant: "unknown", value: null } };
		});
		const disk = createDisk([runtime.extension], clock);
		const { process, instance } = await opened(runtime, disk);
		await instance.enqueue(batch, context);
		await process.settle();
		expect(calls).toBe(1);
		expect((await instance.state(context)).marking).toStrictEqual({ "work:busy": [{ job: "A" }] });
		await expect(instance.resolve("work/1", { variant: "bad", value: null }, context)).rejects.toThrow();
		await instance.resolve("work/1", answer, context);
		expect((await instance.state(context)).marking).toStrictEqual({ output: ["A"] });
		expect(calls).toBe(1);
	},
);

test("crashes around allocation, launch, termination and settlement preserve one result and one worker", async () => {
	for (const after of [false, true]) {
		for (let commit = 0; commit < 26; commit += 1) {
			const clock = createClock();
			const runtime = native(clock, () => ({ status: "completed", result: answer }));
			const disk = createDisk([runtime.extension], clock);
			await enqueueAndSettle(disk, after ? { crashAfterCommit: commit } : { crashAtCommit: commit }, runtime, batch);
			const { process, instance } = await opened(runtime, disk);
			const state = await instance.state(context);
			expect(state.marking).toStrictEqual({ output: ["A"] });
			expect(await instance.budget(context)).toStrictEqual({ ceiling: 10, used: 1, paused: false });
			for (const committed of disk.history()) {
				expect(replay(runtime.net, {}, committed.log)).toStrictEqual(committed.marking);
			}
			expect(
				state.log.filter((entry) => entry.kind === "ingress" && entry.requestId === "result:work/1"),
			).toHaveLength(1);
			expect((await process.harness.commit((tx) => tx.scanTasks({}, 100), context)).items).toHaveLength(2);
		}
	}
});

const loop: Transition<"job"> = {
	id: transitionId("loop"),
	variables: { job: text },
	guard: () => true,
	inputs: [{ place: input, variables: ["job"] }],
	outputs: [{ place: input, expression: ({ job }) => [job] }],
};
const loopNet: Net = { places: [input], transitions: [loop] };

test("cancelling a launched pure execution retains its binding without inventing a result", async () => {
	const clock = createClock();
	const runtime = createRuntime({
		name: "pure-cancellation",
		nonce: randomUUID(),
		clock,
		policy: definitionOrder,
		net: loopNet,
		startLimit: 1,
	});
	const disk = createDisk([runtime.extension], clock);
	expect(
		await inProcess(disk, { crashAfterCommit: 3 }, async ({ harness, settle }) => {
			await runtime.instance(harness, (await harness.root(context)).id).enqueue(batch, context);
			await settle();
		}),
	).toBe("crashed");
	const { process, instance } = await opened(runtime, disk);
	const records = await process.harness.commit((tx) => tx.scanTasks({}, 100), context);
	expect(records.items).toHaveLength(2);
	expect(records.items.find((task) => task.owner !== undefined)?.state.status).toBe("pending");
	await instance.abort("loop/1", context);
	await process.settle();
	const ended = await process.harness.commit((tx) => tx.scanTasks({}, 100), context);
	expect(ended.items.map((task) => task.state)).toStrictEqual([
		{ status: "terminal", outcome: { status: "aborted" } },
		{ status: "terminal", outcome: { status: "aborted" } },
	]);
	expect((await instance.state(context)).marking).toStrictEqual({ "loop:busy": [{ job: "A" }] });
	expect(await instance.inFlight(context)).toHaveLength(1);
	await expect(instance.resolve("loop/1", { variant: "done", value: "not unit" }, context)).rejects.toThrow(
		"invalid batch result:loop/1",
	);
	await instance.resolve("loop/1", { variant: "done", value: null }, context);
	expect((await instance.state(context)).marking).toStrictEqual(batch.tokens);
	expect(await instance.budget(context)).toStrictEqual({ ceiling: 1, used: 1, paused: true });
});

test("pure work schedules tasks and a durable ceiling stops cycles across reopen and idempotent increases", async () => {
	await fc.assert(
		fc.asyncProperty(fc.integer({ min: 0, max: 4 }), async (ceiling) => {
			const clock = createClock();
			const options = {
				name: "loop",
				nonce: randomUUID(),
				clock,
				policy: definitionOrder,
				net: loopNet,
				startLimit: ceiling,
			};
			const runtime = createRuntime(options);
			const disk = createDisk([runtime.extension], clock);
			await enqueueAndSettle(disk, {}, runtime, batch);
			const reopened = createRuntime({ ...options, nonce: randomUUID(), startLimit: 999 });
			const { process, instance } = await opened(reopened, disk);
			expect(await instance.budget(context)).toStrictEqual({ ceiling, used: ceiling, paused: true });
			const tasks = await process.harness.commit((tx) => tx.scanTasks({}, 100), context);
			expect(tasks.items).toHaveLength(ceiling * 2);
			await Promise.all([
				instance.raiseStartLimit(ceiling + 2, context),
				instance.raiseStartLimit(ceiling + 2, context),
			]);
			await process.settle();
			expect(await instance.budget(context)).toStrictEqual({
				ceiling: ceiling + 2,
				used: ceiling + 2,
				paused: true,
			});
			const resumedTasks = await process.harness.commit((tx) => tx.scanTasks({}, 100), context);
			expect(resumedTasks.items).toHaveLength((ceiling + 2) * 2);
			expect((await instance.state(context)).marking).toStrictEqual(batch.tokens);
		}),
		{ numRuns: 10 },
	);
});

test("a step over budget reserves none of its bindings and pausing still lets existing work settle", async () => {
	const clock = createClock();
	const runtime = native(clock, () => ({ status: "completed", result: answer }), 2);
	const disk = createDisk([runtime.extension], clock);
	const { process, instance } = await opened(runtime, disk);
	await instance.enqueue(batch, context);
	await instance.enqueue({ requestId: "second", tokens: { [input.id]: ["B", "C"] } }, context);
	expect(await instance.budget(context)).toStrictEqual({ ceiling: 2, used: 1, paused: true });
	await process.settle();
	expect((await instance.state(context)).marking).toStrictEqual({ input: ["B", "C"], output: ["A"] });
	await instance.raiseStartLimit(3, context);
	await process.settle();
	expect((await instance.state(context)).marking).toStrictEqual({ output: ["A", "B", "C"] });
	expect(await instance.budget(context)).toStrictEqual({ ceiling: 3, used: 3, paused: false });
});

test("old execution models cannot reopen as native instances", async () => {
	const clock = createClock();
	const runtime = native(clock, () => ({ status: "completed", result: answer }));
	const disk = createDisk([runtime.extension], clock);
	const { process, instance } = await opened(runtime, disk);
	const root = await process.harness.root(context);
	await process.harness.commit(async (tx) => {
		(await tx.doc(netInstanceRecord, root.id)).model = "old";
	}, context);
	await expect(instance.enqueue(batch, context)).rejects.toThrow("another execution model");
	await expect(instance.state(context)).rejects.toThrow("another execution model");
	await expect(instance.budget(context)).rejects.toThrow("another execution model");
});

type StoredTask = NonNullable<Awaited<ReturnType<Tx["task"]>>>;

function changedTaskReads(
	host: NetInstanceHost,
	change: (task: StoredTask) => StoredTask | undefined,
): NetInstanceHost {
	return {
		snapshot: host.snapshot.bind(host),
		abortTask: host.abortTask.bind(host),
		commit: (body, callContext) =>
			host.commit(
				(tx) =>
					body(
						new Proxy(tx, {
							get: (target, property): unknown => {
								if (property === "task")
									return async (id: TaskId) => {
										const task = await target.task(id);
										return task === undefined ? undefined : change(task);
									};
								const value: unknown = Reflect.get(target, property, target);
								return typeof value === "function" ? value.bind(target) : value;
							},
						}),
					),
				callContext,
			),
	};
}

test("resolution rejects missing, foreign, mismatched and live workers without changing held inputs", async () => {
	const clock = createClock();
	const runtime = native(clock, () => ({ status: "aborted" }));
	const disk = createDisk([runtime.extension], clock);
	const { process, instance } = await opened(runtime, disk);
	const root = await process.harness.root(context);
	const other = await process.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	await instance.enqueue(batch, context);
	await process.runReady();
	const records = await process.harness.commit((tx) => tx.scanTasks({}, 100), context);
	const sleeping = records.items.find((task) => task.state.status === "sleeping");
	if (sleeping === undefined) throw new Error("the native worker must sleep before completing");
	await process.settle();
	const before = await instance.state(context);
	const changes: readonly ((task: StoredTask) => StoredTask | undefined)[] = [
		() => undefined,
		(task) => ({ ...task, owner: task.id }),
		(task) => ({ ...task, conversationId: other.id }),
		(task) => ({ ...task, input: { id: "work/1", binding: { job: "different" } } }),
		() => sleeping,
	];
	for (const change of changes) {
		const host = changedTaskReads(process.harness, (task) => (task.id === sleeping.id ? change(task) : task));
		await expect(runtime.instance(host, root.id).resolve("work/1", answer, context)).rejects.toThrow(
			/native execution record|execution of operation work\/1 has not ended/,
		);
		expect(await instance.state(context)).toStrictEqual(before);
	}
	await instance.resolve("work/1", answer, context);
	expect((await instance.state(context)).marking).toStrictEqual({ output: ["A"] });
});

test("equal operation ids in different conversations resolve only their own binding", async () => {
	const clock = createClock();
	const runtime = native(clock, () => ({ status: "aborted" }));
	const disk = createDisk([runtime.extension], clock);
	const { process, instance } = await opened(runtime, disk);
	const other = await process.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	const second = runtime.instance(process.harness, other.id);
	await instance.enqueue(batch, context);
	await second.enqueue({ requestId: "first", tokens: { [input.id]: ["B"] } }, context);
	await process.settle();
	await second.resolve("work/1", answer, context);
	expect((await second.state(context)).marking).toStrictEqual({ output: ["B"] });
	expect((await instance.state(context)).marking).toStrictEqual({ "work:busy": [{ job: "A" }] });
	await instance.resolve("work/1", answer, context);
	expect((await instance.state(context)).marking).toStrictEqual({ output: ["A"] });
});

test("start ceilings reject invalid values and preserve prior increases and usage", async () => {
	const clock = createClock();
	for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
		expect(() => native(clock, () => ({ status: "aborted" }), invalid)).toThrow("safe integer");
	}
	const runtime = native(clock, () => ({ status: "completed", result: answer }), 0);
	const disk = createDisk([runtime.extension], clock);
	const { instance, process } = await opened(runtime, disk);
	expect(await instance.budget(context)).toStrictEqual({ ceiling: 0, used: 0, paused: false });
	await expect(instance.enqueue({ requestId: "start-limit:1", tokens: {} }, context)).rejects.toThrow("reserved");
	expect(await instance.state(context)).toStrictEqual({ marking: {}, log: [] });
	await instance.raiseStartLimit(0, context);
	await instance.enqueue(batch, context);
	await instance.raiseStartLimit(0, context);
	expect(await instance.budget(context)).toStrictEqual({ ceiling: 0, used: 0, paused: true });
	await instance.raiseStartLimit(1, context);
	await process.settle();
	await instance.raiseStartLimit(3, context);
	const before = await instance.state(context);
	await expect(instance.raiseStartLimit(2, context)).rejects.toThrow("cannot decrease");
	await expect(instance.raiseStartLimit(-1, context)).rejects.toThrow("safe integer");
	await instance.raiseStartLimit(1, context);
	expect(await instance.state(context)).toStrictEqual(before);
	expect(await instance.budget(context)).toStrictEqual({ ceiling: 3, used: 1, paused: false });
});

async function interrupted(boundary: "allocated" | "launched" | "completed"): Promise<{
	readonly runtime: Runtime;
	readonly disk: Disk;
	readonly memory: MemoryStorage;
	readonly coordinator: StoredTask;
	readonly workers: readonly StoredTask[];
}> {
	const clock = createClock();
	const memory = new MemoryStorage();
	const runtime = native(clock, () => ({ status: "completed", result: answer }));
	const disk = createDisk([runtime.extension], clock, memory);
	const commit = { allocated: undefined, launched: 3, completed: 7 }[boundary];
	const faults = commit === undefined ? {} : { crashAfterCommit: commit };
	await inProcess(disk, faults, async ({ harness, settle }) => {
		await runtime.instance(harness, (await harness.root(context)).id).enqueue(batch, context);
		if (boundary !== "allocated") await settle();
	});
	const records = await memory.scanTasks({}, 100, undefined, context);
	const coordinator = records.items.find((record) => record.owner === undefined);
	if (coordinator === undefined) throw new Error("allocation must create a coordinator");
	return { runtime, disk, memory, coordinator, workers: records.items.filter((record) => record.owner !== undefined) };
}

test.each(["missing-wait", "wrong-worker"] as const)(
	"a %s coordinator checkpoint faults without releasing the binding",
	async (fault) => {
		const { runtime, memory, disk, coordinator, workers } = await interrupted("launched");
		const worker = workers[0];
		if (worker === undefined) throw new Error("launch must create its worker");
		const { memos, ...stored } = coordinator;
		expect(memos).toBeUndefined();
		await memory.commit(
			[
				{
					type: "task",
					value: {
						...stored,
						state: {
							status: "running",
							checkpoint: { phase: "settle", worker: fault === "missing-wait" ? worker.id : coordinator.id },
						},
					},
				},
			],
			context,
		);
		const { process, instance } = await opened(runtime, disk);
		await process.settle();
		expect((await instance.state(context)).marking).toStrictEqual({ "work:busy": [{ job: "A" }] });
		expect((await process.harness.getTask(coordinator.id, context))?.state).toMatchObject({
			status: "terminal",
			outcome: {
				status: "faulted",
				error: {
					message:
						fault === "missing-wait" ? "execution of work/1 has not ended" : "inconsistent execution for work/1",
				},
			},
		});
		await instance.resolve("work/1", answer, context);
		expect((await instance.state(context)).marking).toStrictEqual({ output: ["A"] });
	},
);

test("stored malformed native result envelopes fault settlement and retain recoverable inputs", async () => {
	const envelopeError = "native execution returned an invalid result envelope";
	const invalid: readonly (readonly [JsonValue, string])[] = [
		[null, envelopeError],
		[[], envelopeError],
		[{ variant: 4, value: "receipt" }, envelopeError],
		[{ variant: "done" }, envelopeError],
		[{ variant: "done", value: "receipt", extra: true }, envelopeError],
		[{ variant: "done", value: false }, "invalid batch result:work/1"],
	];
	for (const [result, error] of invalid) {
		const { runtime, memory, disk, workers, coordinator } = await interrupted("completed");
		const worker = workers[0];
		if (worker?.state.status !== "terminal") throw new Error("the crash must follow native completion");
		expect(coordinator.state.status).not.toBe("terminal");
		const { memos, ...terminal } = worker;
		expect(memos).toBeUndefined();
		// Storage is the serialization boundary: task authors' static types cannot validate a retained record.
		await memory.commit(
			[
				{
					type: "task",
					value: {
						...terminal,
						state: { status: "terminal", outcome: { status: "completed", result } },
					},
				},
			],
			context,
		);
		const { process, instance } = await opened(runtime, disk);
		await process.settle();
		expect((await instance.state(context)).marking).toStrictEqual({ "work:busy": [{ job: "A" }] });
		expect(String(disk.reports().at(-1))).toContain(error);
		await instance.resolve("work/1", answer, context);
		expect((await instance.state(context)).marking).toStrictEqual({ output: ["A"] });
	}
});

test.each([
	["missing", "allocated", "inconsistent launch for work/1"],
	["already-launched", "allocated", "inconsistent launch for work/1"],
	["changed-worker", "completed", "inconsistent execution for work/1"],
] as const)(
	"a %s launch receipt cannot release inputs through scheduling or operator resolution",
	async (fault, boundary, message) => {
		const { runtime, memory, disk, coordinator } = await interrupted(boundary);
		const receipts = await memory.scanDocuments(
			{
				kind: "petrus.native-launch",
				at: "current",
				scope: { kind: "conversation", conversationId: coordinator.conversationId },
			},
			100,
			undefined,
			context,
		);
		const receipt = receipts.items[0];
		if (receipt === undefined) throw new Error("allocation must persist its launch receipt");
		await memory.commit(
			[
				fault === "missing"
					? { type: "document.retire", id: receipt.id }
					: {
							type: "document.change",
							id: receipt.id,
							content: {
								kind: "base",
								version: 1,
								value: { initialized: true, worker: coordinator.id },
							},
						},
			],
			context,
		);
		const { process, instance } = await opened(runtime, disk);
		await process.settle();
		expect((await process.harness.getTask(coordinator.id, context))?.state).toMatchObject({
			status: "terminal",
			outcome: {
				status: "faulted",
				error: { message },
			},
		});
		expect((await instance.state(context)).marking).toStrictEqual({ "work:busy": [{ job: "A" }] });
		await expect(instance.resolve("work/1", answer, context)).rejects.toThrow(/missing|inconsistent/);
	},
);
