import type { ConversationRecord, TaskId } from "@earendil-works/pi-durable";
import { defineExtension, defineTask } from "@earendil-works/pi-durable";
import { transitionId } from "@petrus/petri-net";
import { describe, expect, onTestFinished, test } from "vitest";
import type { Execution, ExecutionInput } from "../src/execution.ts";
import { execution } from "../src/execution.ts";
import type { HandlerResult, HandlerTransition } from "../src/handlers.ts";
import type { Disk, Process } from "./disk.ts";
import { context, createDisk } from "./disk.ts";

const transition: HandlerTransition = {
	id: transitionId("native"),
	variables: {},
	guard: () => true,
	inputs: [],
	variants: {},
};

type SleepCheckpoint = { readonly phase: "start" } | { readonly phase: "finish"; readonly answer: HandlerResult };
type DeliveryCheckpoint = { readonly phase: "prepare" } | { readonly phase: "deliver"; readonly label: string };
type SleepHooks = { readonly slept: (until: number) => void };
type DeliveryHooks = { readonly delivered: (label: string) => void };

const sleeper = defineTask<ExecutionInput, SleepCheckpoint, HandlerResult, SleepHooks>({
	name: "execution-test:sleeper",
	version: 1,
	initial: () => ({ phase: "start" }),
	phases: {
		start: async ({ input }, runtime, callContext) => {
			await runtime.sleepUntil(
				input.startedAt + 5,
				{ phase: "finish", answer: { variant: "slept", value: input } },
				callContext,
			);
		},
		finish: async ({ state }, runtime, callContext) => {
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: state.checkpoint.answer } }),
				callContext,
			);
		},
	},
	abort: async (_task, runtime, callContext) => {
		await runtime.commit(
			() => ({ status: "terminal", outcome: { status: "completed", result: { variant: "stopped", value: 42 } } }),
			callContext,
		);
	},
});

const delivery = defineTask<ExecutionInput, DeliveryCheckpoint, HandlerResult, DeliveryHooks>({
	name: "execution-test:delivery",
	version: 1,
	initial: () => ({ phase: "prepare" }),
	phases: {
		prepare: async ({ input }, runtime, callContext) => {
			if (input.binding.fail === true) {
				throw new Error("delivery failed");
			}
			await runtime.commit(
				() => ({ status: "running", checkpoint: { phase: "deliver", label: input.id } }),
				callContext,
			);
		},
		deliver: async ({ state }, runtime, callContext) => {
			await runtime.commit(
				() => ({
					status: "terminal",
					outcome: { status: "completed", result: { variant: "delivered", value: state.checkpoint.label } },
				}),
				callContext,
			);
		},
	},
	abort: async (_task, runtime, callContext) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext);
	},
});

const ownerTask = defineTask<null, { readonly phase: "hold" }, null>({
	name: "execution-test:owner",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (_task, runtime, callContext) => {
			await runtime.sleepUntil(1000, { phase: "hold" }, callContext);
		},
	},
	abort: async (_task, runtime, callContext) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext);
	},
});

const sleepingExecution = execution(transition, sleeper);
const deliveryExecution = execution(transition, delivery);
const executions: readonly Execution[] = [sleepingExecution, deliveryExecution];
const input: ExecutionInput = {
	id: "native/7",
	transition: transition.id,
	binding: { nested: [null, true, { count: 3 }] },
	startedAt: 0,
};

async function opened(): Promise<
	Process & { readonly disk: Disk; readonly owner: TaskId; readonly conversation: ConversationRecord }
> {
	const disk = createDisk([
		defineExtension({ name: "execution-test:owner", tasks: [ownerTask] }),
		...executions.map((registered) => registered.extension),
	]);
	const process = await disk.open();
	const { harness } = process;
	onTestFinished(() => harness.close(context));
	const conversation = await harness.root(context);
	const owner = await harness.commit(
		(tx) => tx.createTask(ownerTask, null, { ownership: { kind: "conversation" }, conversationId: conversation.id }),
		context,
	);
	return { ...process, disk, owner, conversation };
}

describe("execution", () => {
	test("registers unrelated native tasks and preserves their input, ownership, checkpoints and results", async () => {
		const { harness, runReady, disk, owner, conversation } = await opened();
		const ids = await harness.commit(
			(tx) => Promise.all(executions.map((registered) => registered.launch(tx, input, owner))),
			context,
		);
		for (const id of ids) {
			expect(await harness.getTask(id, context)).toMatchObject({ input, owner, conversationId: conversation.id });
		}
		const [sleepId, deliveryId] = ids;
		if (sleepId === undefined || deliveryId === undefined) {
			throw new Error("both executions must create a task");
		}
		expect(executions.map((registered) => registered.transition)).toStrictEqual([transition, transition]);
		await runReady();
		expect(await harness.getTask(sleepId, context)).toMatchObject({
			kind: sleeper.definition.name,
			state: { status: "sleeping", until: 5, checkpoint: { phase: "finish" } },
		});
		disk.clock.moveTo(5);
		await runReady();
		expect((await harness.waitForTask(sleepId, context)).state.outcome).toStrictEqual({
			status: "completed",
			result: { variant: "slept", value: input },
		});
		expect((await harness.waitForTask(deliveryId, context)).state.outcome).toStrictEqual({
			status: "completed",
			result: { variant: "delivered", value: input.id },
		});
		expect(disk.reports()).toStrictEqual([]);
	});

	test("keeps the native task's abort result", async () => {
		const { harness, runReady, owner } = await opened();
		const id = await harness.commit((tx) => sleepingExecution.launch(tx, input, owner), context);
		await harness.abortTask(id, context);
		await runReady();
		expect((await harness.waitForTask(id, context)).state.outcome).toStrictEqual({
			status: "completed",
			result: { variant: "stopped", value: 42 },
		});
	});

	test("leaves an uncaught native error faulted instead of adding retries or a result", async () => {
		const { harness, runReady, owner } = await opened();
		const id = await harness.commit(
			(tx) => deliveryExecution.launch(tx, { ...input, binding: { fail: true } }, owner),
			context,
		);
		await runReady();
		expect((await harness.waitForTask(id, context)).state.outcome).toStrictEqual({
			status: "faulted",
			error: { message: "delivery failed" },
		});
	});
});
