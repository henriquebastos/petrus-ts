import { expect, onTestFinished, test } from "vitest";
import { defineTask } from "@earendil-works/pi-durable";
import type { ConversationRecord, TaskInspection } from "@earendil-works/pi-durable";
import type { Execution, ExecutionInput, HandlerResult, NetInstance, Runtime } from "../src/index.ts";
import { createRuntime, execution } from "../src/index.ts";
import { netInstanceRecord } from "../src/net-instance-record.ts";
import { untilAborted } from "./abort-properties.ts";
import { immediateExecution } from "./native-execution.ts";
import { context, createClock, createDisk, Crashed, inProcess } from "./disk.ts";
import type { Disk, Process, TestClock } from "./disk.ts";
import {
	createService,
	finished,
	firstBatch,
	jobsOptions,
	receipts,
	refused,
	slots,
	work,
} from "./handler-properties.ts";

const answer = { variant: "done", value: "receipt repaired" };

function sleepingWork(delayMs: number, calls: () => void = () => undefined): Execution {
	return execution(
		work,
		defineTask<ExecutionInput, { readonly phase: "run" } | { readonly phase: "due" }, HandlerResult>({
			name: "recovery:sleeping-work",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async ({ input }, runtime, context) => {
					calls();
					await runtime.sleepUntil(input.startedAt + delayMs, { phase: "due" }, context);
				},
				due: async (_task, runtime, context) => {
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: answer } }),
						context,
					);
				},
			},
			abort: async (_task, runtime, context) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
			},
		}),
	);
}

async function opened(handler?: Execution): Promise<
	Process & {
		readonly instance: NetInstance;
		readonly runtime: Runtime;
		readonly root: ConversationRecord;
		readonly task: TaskInspection;
		readonly disk: Disk;
		readonly clock: TestClock;
	}
> {
	const clock = createClock();
	const options = jobsOptions(
		createService(() => []),
		clock,
	);
	const runtime = createRuntime({
		...options,
		executions: [handler ?? immediateExecution(work, () => Promise.resolve(answer))],
	});
	const disk = createDisk([runtime.extension], clock);
	const process = await disk.open();
	onTestFinished(() => process.harness.close(context));
	const root = await process.harness.root(context);
	const instance = runtime.instance(process.harness, root.id);
	await instance.enqueue(firstBatch(["j1"]), context);
	const [task] = (await process.harness.inspect(context)).tasks;
	if (task === undefined) {
		throw new Error("the enqueue started no task");
	}
	return { ...process, instance, runtime, root, task, disk, clock };
}

test("repairs a faulted operation and resolves its result once without restarting its task", async () => {
	const { harness, instance, root, task, settle, disk, clock } = await opened();
	await harness.commit(async (tx) => {
		const draft = await tx.doc(netInstanceRecord, root.id);
		draft.net = "broken";
		draft.stamp = "";
	}, context);
	await settle();
	expect((await harness.getTask(task.record.id, context))?.state).toMatchObject({
		status: "terminal",
		outcome: { status: "faulted" },
	});
	await expect(instance.inFlight(context)).rejects.toThrow("not jobs");
	await harness.commit(async (tx) => {
		const draft = await tx.doc(netInstanceRecord, root.id);
		draft.net = "jobs";
		draft.stamp = "";
	}, context);
	expect(await instance.inFlight(context)).toHaveLength(1);
	clock.moveTo(9);
	const before = disk.history().length;
	await expect(instance.resolve("work/1", { variant: "done", value: null }, context)).rejects.toThrow(
		"invalid batch result:work/1",
	);
	expect(disk.history()).toHaveLength(before);
	const [first, repeated] = await Promise.all([
		instance.resolve("work/1", answer, context),
		instance.resolve("work/1", { variant: "refused", value: "refused" }, context),
	]);
	expect(first.ingress).toMatchObject({ requestId: "result:work/1", at: 9 });
	expect(first.fired).toHaveLength(1);
	expect(repeated).toStrictEqual({ ingress: first.ingress, fired: [] });
	expect(disk.history()).toHaveLength(before + 1);
	expect((await instance.state(context)).marking).toStrictEqual({
		[slots.id]: ["slot", "slot"],
		[finished.id]: ["j1"],
		[receipts.id]: [answer.value],
	});
	expect(await instance.inFlight(context)).toStrictEqual([]);
	expect((await harness.getTask(task.record.id, context))?.state).toMatchObject({
		status: "terminal",
		outcome: { status: "faulted" },
	});
});

test("refuses invalid results and unknown operations without changing a terminal operation", async () => {
	const { harness, task, instance, settle, disk } = await opened();
	await settle();
	const before = await instance.state(context);
	const terminal = await harness.getTask(task.record.id, context);
	const commits = disk.history().length;
	await expect(instance.resolve("work/1", { variant: "lost", value: null }, context)).rejects.toThrow(
		"invalid batch result:work/1",
	);
	await expect(instance.resolve("work/999", answer, context)).rejects.toThrow(
		"no coordinator runs the operation work/999",
	);
	await expect(instance.resolve("work/1", { variant: "done", value: null }, context)).rejects.toThrow(
		"invalid batch result:work/1",
	);
	const repeated = await instance.resolve("work/1", { variant: "refused", value: "refused" }, context);
	expect(repeated).toStrictEqual({ ingress: before.log[2], fired: [] });
	expect(await instance.state(context)).toStrictEqual(before);
	expect(disk.history()).toHaveLength(commits);
	expect(await harness.getTask(task.record.id, context)).toStrictEqual(terminal);
});

test("a failed resolution commits nothing and a retry releases an aborted operation's tokens once", async () => {
	const { harness, instance, runtime, root, task, settle, disk } = await opened();
	await harness.abortTask(task.record.id, context);
	await settle();
	const terminal = await harness.getTask(task.record.id, context);
	expect(terminal?.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
	const before = await instance.state(context);
	const commits = disk.history().length;
	const failed = runtime.instance(
		{
			snapshot: harness.snapshot.bind(harness),
			abortTask: harness.abortTask.bind(harness),
			commit: (change, callContext) =>
				harness.commit(async (tx) => {
					await change(tx);
					throw new Error("resolution transaction failed");
				}, callContext),
		},
		root.id,
	);
	await expect(failed.resolve("work/1", answer, context)).rejects.toThrow("resolution transaction failed");
	expect(await instance.state(context)).toStrictEqual(before);
	expect(disk.history()).toHaveLength(commits);
	expect(await harness.getTask(task.record.id, context)).toStrictEqual(terminal);
	const resolved = await instance.resolve("work/1", answer, context);
	expect(resolved.fired).toHaveLength(1);
	expect(await instance.resolve("work/1", answer, context)).toStrictEqual({
		ingress: resolved.ingress,
		fired: [],
	});
	expect((await instance.state(context)).marking).toStrictEqual({
		[slots.id]: ["slot", "slot"],
		[finished.id]: ["j1"],
		[receipts.id]: [answer.value],
	});
	expect(await instance.inFlight(context)).toStrictEqual([]);
	expect(disk.history()).toHaveLength(commits + 1);
	expect(await harness.getTask(task.record.id, context)).toStrictEqual(terminal);
});

test("refuses pending, running and sleeping tasks before recording a supplied result", async () => {
	const entered = Promise.withResolvers<undefined>();
	const { harness, instance, task } = await opened(
		immediateExecution(work, (_input, signal) => {
			entered.resolve(undefined);
			return untilAborted(signal);
		}),
	);
	const before = await instance.state(context);
	await expect(instance.resolve("work/1", answer, context)).rejects.toThrow("has not ended");
	harness.resume();
	await entered.promise;
	expect((await harness.getTask(task.record.id, context))?.state.status).toBe("waiting");
	await expect(instance.resolve("work/1", answer, context)).rejects.toThrow("has not ended");
	expect(await instance.state(context)).toStrictEqual(before);
	const sleeping = await opened(sleepingWork(100));
	await sleeping.runReady();
	expect((await sleeping.harness.getTask(sleeping.task.record.id, context))?.state.status).toBe("waiting");
	expect(
		(await sleeping.harness.inspect(context)).tasks.some(({ record }) => record.state.status === "sleeping"),
	).toBe(true);
	await expect(sleeping.instance.resolve("work/1", answer, context)).rejects.toThrow("has not ended");
	expect(await sleeping.instance.inFlight(context)).toHaveLength(1);
});

test.each([false, true])(
	"a settlement fault accepts a corrected result without retrying the native worker (delayed=%s)",
	async (delayed) => {
		const clock = createClock();
		let calls = 0;
		const broken = {
			...work,
			variants: {
				...work.variants,
				done: {
					value: receipts.colourSet,
					outputs: [
						{
							place: finished,
							expression: (): never => {
								throw new Error("broken done arc");
							},
						},
					],
				},
			},
		};
		const countCall = (): void => {
			calls += 1;
		};
		const native = delayed
			? sleepingWork(10, countCall)
			: immediateExecution(work, () => {
					countCall();
					return Promise.resolve(answer);
				});
		const runtime = createRuntime({
			...jobsOptions(
				createService(() => []),
				clock,
			),
			executions: [{ ...native, transition: broken }],
		});
		const disk = createDisk([runtime.extension], clock);
		const { harness, settle } = await disk.open();
		onTestFinished(() => harness.close(context));
		const instance = runtime.instance(harness, (await harness.root(context)).id);
		await instance.enqueue(firstBatch(["j1"]), context);
		await settle();
		expect(disk.reports().map(String)).toStrictEqual(["Error: broken done arc"]);
		const commits = disk.history().length;
		await expect(instance.resolve("work/1", answer, context)).rejects.toThrow("broken done arc");
		expect(disk.history()).toHaveLength(commits);
		await instance.resolve("work/1", { variant: "refused", value: "refused" }, context);
		expect((await instance.state(context)).marking).toStrictEqual({
			[slots.id]: ["slot", "slot"],
			[refused.id]: ["j1"],
		});
		expect(await instance.inFlight(context)).toStrictEqual([]);
		expect(calls).toBe(1);
	},
);

test("resolve refuses a live coordinator after its worker committed a terminal result before a crash", async () => {
	const clock = createClock();
	const runtime = createRuntime({
		...jobsOptions(
			createService(() => []),
			clock,
		),
		executions: [immediateExecution(work, () => Promise.resolve(answer))],
	});
	const disk = createDisk([runtime.extension], clock);
	// Commit 5 stores the worker's result. The coordinator has not settled that result yet.
	const outcome = await inProcess(disk, { crashAfterCommit: 5 }, async ({ harness, settle }) => {
		await runtime.instance(harness, (await harness.root(context)).id).enqueue(firstBatch(["j1"]), context);
		await settle();
	});
	expect(outcome).toBe("crashed");
	const { harness, settle } = await disk.open();
	onTestFinished(() => harness.close(context));
	const instance = runtime.instance(harness, (await harness.root(context)).id);
	const records = await harness.commit((tx) => tx.scanTasks({}, 100), context);
	const coordinator = records.items.find((record) => record.owner === undefined);
	const worker = records.items.find((record) => record.owner !== undefined);
	expect(coordinator?.state.status).toBe("waiting");
	expect(worker?.state).toStrictEqual({ status: "terminal", outcome: { status: "completed", result: answer } });
	const before = await instance.state(context);
	await expect(instance.resolve("work/1", answer, context)).rejects.toThrow(
		"the coordinator of operation work/1 has not ended",
	);
	expect(await instance.state(context)).toStrictEqual(before);
	await settle();
	expect(await instance.inFlight(context)).toStrictEqual([]);
	expect((await instance.state(context)).marking).toStrictEqual({
		[slots.id]: ["slot", "slot"],
		[finished.id]: ["j1"],
		[receipts.id]: [answer.value],
	});
	expect(disk.reports()).toStrictEqual([new Crashed("the process died after commit 5")]);
});
