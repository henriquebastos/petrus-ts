import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { createRegistry, defineExtension, defineTask, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { Binding } from "@petrus/petri-net";
import type { Execution, HandlerResult } from "@petrus/runtime";
import { expect, onTestFinished, test } from "vitest";
import { diningPhilosophersHandlers } from "../src/dining-philosophers.ts";
import { mutualExclusionHandlers } from "../src/mutual-exclusion.ts";
import { orderProcessHandlers } from "../src/order-process.ts";
import { producerConsumerHandlers } from "../src/producer-consumer.ts";
import { simpleProtocolHandlers } from "../src/simple-protocol.ts";
import { flush } from "./flush.ts";

const context = BACKGROUND_CONTEXT;
const owner = defineTask<null, { readonly phase: "hold" }, null>({
	name: "native-contract:owner",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (_task, runtime, callContext) => {
			await runtime.sleepUntil(100_000, { phase: "hold" }, callContext);
		},
	},
	abort: async (_task, runtime, callContext) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext);
	},
});

const bindings: Readonly<Record<string, Binding>> = {
	produce: { order: "order 1", slot: "slot" },
	consume: { item: "item 1" },
	eat: { philosopher: "p0" },
	critical: { process: "p1", lock: "lock" },
	TransmitPacket: { packet: [1, "data"] },
	TransmitAck: { ack: 2 },
	Wait: { packet: [1, "data"] },
	CheckStock: { c: "o1" },
	Charge: { c: "o1" },
	Undo: { s: ["o1", false], b: ["o1", true] },
};

function executions(calls: string[]): readonly Execution[] {
	const use = (): Promise<void> => {
		calls.push("use");
		return Promise.resolve();
	};
	const succeed = (): Promise<boolean> => {
		calls.push("succeed");
		return Promise.resolve(true);
	};
	return [
		...producerConsumerHandlers({
			make: async () => {
				await use();
				return "item 1";
			},
			use,
		}),
		...diningPhilosophersHandlers(3, { eat: use }),
		...mutualExclusionHandlers({ use }),
		...simpleProtocolHandlers({ transmit: succeed }, 10),
		...orderProcessHandlers({ reserve: succeed, charge: succeed, undo: use }),
	];
}

async function launch(
	name: string,
	binding: Binding,
): Promise<{
	readonly harness: Harness;
	readonly id: TaskId<HandlerResult>;
	readonly calls: readonly string[];
	readonly reports: readonly unknown[];
}> {
	const calls: string[] = [];
	const reports: unknown[] = [];
	const registered = executions(calls).find((candidate) => candidate.transition.id === name);
	if (registered === undefined) throw new Error(`no execution for ${name}`);
	const registry = createRegistry();
	registry.install(registered.extension);
	registry.install(defineExtension({ name: "native-contract:owner", tasks: [owner] }));
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models: createModels(),
			registry,
			now: () => 0,
			onWake: () => undefined,
			onReport: (error) => {
				reports.push(error);
			},
		},
		context,
	);
	onTestFinished(() => harness.close(context));
	const conversation = await harness.root(context);
	const id = await harness.commit(async (tx) => {
		const ownerId = await tx.createTask(owner, null, {
			ownership: { kind: "conversation" },
			conversationId: conversation.id,
		});
		return registered.launch(
			tx,
			{ id: `${name}/1`, transition: registered.transition.id, binding, startedAt: 0 },
			ownerId,
		);
	}, context);
	return { harness, id, calls, reports };
}

async function runReady(harness: Harness): Promise<void> {
	harness.resume();
	while (harness.wake().active) await flush();
}

test.each(Object.entries(bindings))(
	"native %s rejects a missing required binding before calling its service",
	async (name) => {
		const { harness, id, calls, reports } = await launch(name, {});
		await runReady(harness);
		expect((await harness.waitForTask(id, context)).state.outcome).toMatchObject({ status: "faulted" });
		expect(calls).toStrictEqual([]);
		expect(reports).toHaveLength(1);
	},
);

test.each(Object.entries(bindings))(
	"native %s owns its abort outcome without running its service",
	async (name, binding) => {
		const { harness, id, calls, reports } = await launch(name, binding);
		expect(await harness.abortTask(id, context)).toBe("marked");
		await runReady(harness);
		const outcome = (await harness.waitForTask(id, context)).state.outcome;
		expect(outcome).toStrictEqual(
			["CheckStock", "Charge"].includes(name)
				? { status: "completed", result: { variant: "aborted", value: null } }
				: { status: "aborted" },
		);
		expect(calls).toStrictEqual([]);
		expect(reports).toStrictEqual([]);
	},
);

test("aborting a sleeping retransmission timer discards its elapsed result", async () => {
	const { harness, id, reports } = await launch("Wait", { packet: [1, "data"] });
	await runReady(harness);
	expect(await harness.getTask(id, context)).toMatchObject({ state: { status: "sleeping", until: 10 } });
	await harness.abortTask(id, context);
	await runReady(harness);
	expect((await harness.waitForTask(id, context)).state.outcome).toStrictEqual({ status: "aborted" });
	expect(reports).toStrictEqual([]);
});

test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("refuses an invalid retransmission delay %s", (delay) => {
	expect(() => simpleProtocolHandlers({ transmit: () => Promise.resolve(true) }, delay)).toThrow(RangeError);
});
