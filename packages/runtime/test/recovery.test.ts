import { expect, onTestFinished, test } from "vitest";
import type { ConversationRecord, TaskInspection } from "@earendil-works/pi-durable";
import type { Handler, NetInstance, Runtime } from "../src/index.ts";
import { createRuntime } from "../src/index.ts";
import { netInstanceRecord } from "../src/net-instance-record.ts";
import { untilAborted } from "./abort-properties.ts";
import { restlessJobsNet } from "./broken-instance.ts";
import { context, createClock, createDisk } from "./disk.ts";
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

async function opened(handler?: Handler): Promise<
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
		handlers: [handler ?? { transition: work, run: () => Promise.resolve(answer) }],
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
	await expect(instance.resolve("work/999", answer, context)).rejects.toThrow("no task runs the operation work/999");
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
	const { harness, instance, task } = await opened({
		transition: work,
		run: (_binding, { signal }) => {
			entered.resolve(undefined);
			return untilAborted(signal);
		},
	});
	const before = await instance.state(context);
	await expect(instance.resolve("work/1", answer, context)).rejects.toThrow("has not ended");
	harness.resume();
	await entered.promise;
	expect((await harness.getTask(task.record.id, context))?.state.status).toBe("running");
	await expect(instance.resolve("work/1", answer, context)).rejects.toThrow("has not ended");
	expect(await instance.state(context)).toStrictEqual(before);
	const sleeping = await opened({ transition: work, run: () => Promise.resolve({ delayMs: 100, result: answer }) });
	await sleeping.runReady();
	expect((await sleeping.harness.getTask(sleeping.task.record.id, context))?.state.status).toBe("sleeping");
	await expect(sleeping.instance.resolve("work/1", answer, context)).rejects.toThrow("has not ended");
	expect(await sleeping.instance.inFlight(context)).toHaveLength(1);
});

test.each([false, true])(
	"a step-limit fault accepts a corrected result without retrying the handler (delayed=%s)",
	async (delayed) => {
		const clock = createClock();
		let calls = 0;
		const runtime = createRuntime({
			...jobsOptions(
				createService(() => []),
				clock,
			),
			net: restlessJobsNet,
			handlers: [
				{
					transition: work,
					run: () => {
						calls += 1;
						return Promise.resolve(delayed ? { delayMs: 10, result: answer } : answer);
					},
				},
			],
		});
		const disk = createDisk([runtime.extension], clock);
		const { harness, settle } = await disk.open();
		onTestFinished(() => harness.close(context));
		const instance = runtime.instance(harness, (await harness.root(context)).id);
		await instance.enqueue(firstBatch(["j1"]), context);
		await settle();
		expect(disk.reports().map(String)).toStrictEqual([
			"BrokenNetInstance: the net did not become quiet after 1000 steps",
		]);
		const commits = disk.history().length;
		await expect(instance.resolve("work/1", answer, context)).rejects.toThrow("did not become quiet");
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
