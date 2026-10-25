import fc from "fast-check";
import type { SelectionPolicy } from "@petrus/petri-net";
import { definitionOrder, placeId, transitionId } from "@petrus/petri-net";
import { describe, expect, onTestFinished, test } from "vitest";
import type { NetInstance, Runtime, RuntimeOptions } from "../src/index.ts";
import { createRuntime } from "../src/index.ts";
import { stepLimit } from "../src/advance.ts";
import { netInstanceRecord } from "../src/net-instance-record.ts";
import type { JsonValue } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";

/** The net instance record as version 1 stored it: no index of the ingresses. */
const netInstanceRecordVersion1 = defineDoc<{ net: string; marking: Record<string, JsonValue[]>; log: JsonValue[] }>({
	kind: netInstanceRecord.definition.kind,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ net: "", marking: {}, log: [] }),
	checkpointWhen: () => false,
});
import type { Disk, Process, TestClock } from "./disk.ts";
import { context, createClock, createDisk, Crashed } from "./disk.ts";
import {
	contested,
	contestedOptions,
	counted,
	counter,
	crashProperty,
	left,
	move,
	raceProperty,
	ready,
	right,
} from "./properties.ts";

const takeLeft = transitionId("take-left");
const takeRight = transitionId("take-right");

type Opened = { readonly disk: Disk; readonly process: Process; readonly instance: NetInstance };

/** A runtime of the contested net in the root conversation of a new process; the test closes its Harness. */
async function opened(overrides: Partial<RuntimeOptions> = {}, clock: TestClock = createClock()): Promise<Opened> {
	const runtime = createRuntime({ ...contestedOptions(definitionOrder, clock), ...overrides });
	const disk = createDisk([runtime.extension], clock);
	return { disk, ...(await instanceIn(disk, runtime)) };
}

async function instanceIn(disk: Disk, runtime: Runtime): Promise<Omit<Opened, "disk">> {
	const process = await disk.open();
	onTestFinished(() => process.harness.close(context));
	return { process, instance: runtime.instance(process.harness, (await process.harness.root(context)).id) };
}

const batch = { requestId: "delivery-1", tokens: { [ready.id]: ["j1", "j2"] } };

describe("createRuntime, examples", () => {
	test("a conversation with no instance has no tokens, an empty log and nothing in flight", async () => {
		const { instance } = await opened();
		expect(await instance.state(context)).toStrictEqual({ marking: {}, log: [] });
		expect(await instance.inFlight(context)).toStrictEqual([]);
	});

	test("the first enqueue gives the first tokens, and one commit holds its ingress and the steps' occurrences, stamped by the clock", async () => {
		const clock = createClock(5_000);
		const { disk, instance } = await opened({}, clock);
		clock.moveTo(6_000);
		const committed = await instance.enqueue(batch, context);
		const ingress = { kind: "ingress", ...batch, at: 6_000 };
		const fired = [
			{ kind: "occurrence", transition: takeLeft, binding: { j: "j1" }, at: 6_000 },
			{ kind: "occurrence", transition: takeLeft, binding: { j: "j2" }, at: 6_000 },
		];
		expect(committed).toStrictEqual({ ingress, fired });
		const state = { marking: { [left.id]: ["j1", "j2"] }, log: [ingress, ...fired] };
		expect(await instance.state(context)).toStrictEqual(state);
		expect(disk.history()).toStrictEqual([state]);
	});

	test("lets the policy decide which transition takes a contested token", async () => {
		const rightOnly: SelectionPolicy = (enabled) => enabled.filter((element) => element.transition === takeRight);
		const { instance } = await opened({ policy: rightOnly });
		const { fired } = await instance.enqueue(batch, context);
		expect(fired.map((occurrence) => occurrence.transition)).toStrictEqual([takeRight, takeRight]);
		expect((await instance.state(context)).marking).toStrictEqual({ [right.id]: ["j1", "j2"] });
	});

	test("a commit steps until the net is quiet: a policy that fires one element a step still fires them all", async () => {
		const { disk, instance } = await opened({ policy: (enabled) => enabled.slice(0, 1) });
		const { fired } = await instance.enqueue(batch, context);
		expect(fired.map((occurrence) => occurrence.binding)).toStrictEqual([{ j: "j1" }, { j: "j2" }]);
		expect(disk.history().map((state) => state.marking)).toStrictEqual([{ [left.id]: ["j1", "j2"] }]);
	});

	test("a batch that enables nothing commits its ingress and fires nothing", async () => {
		const { disk, instance } = await opened();
		const idle = { requestId: "delivery-1", tokens: { [right.id]: ["j1"] } };
		const { ingress, fired } = await instance.enqueue(idle, context);
		expect(fired).toStrictEqual([]);
		expect(disk.history()).toStrictEqual([{ marking: { [right.id]: ["j1"] }, log: [ingress] }]);
	});

	test("a batch sent again returns the recorded ingress, fires nothing and commits nothing", async () => {
		const clock = createClock(1);
		const { disk, instance } = await opened({}, clock);
		const first = await instance.enqueue(batch, context);
		clock.moveTo(2);
		expect(await instance.enqueue(batch, context)).toStrictEqual({ ingress: first.ingress, fired: [] });
		expect(disk.history()).toHaveLength(1);
	});

	test("after a crash right after the commit landed, the batch sent again on a new process returns the recorded ingress", async () => {
		const clock = createClock(1);
		const runtime = createRuntime(contestedOptions(definitionOrder, clock));
		const disk = createDisk([runtime.extension], clock);
		const dying = await disk.open({ crashAfterCommit: 1 });
		const root = await dying.harness.root(context);
		await expect(runtime.instance(dying.harness, root.id).enqueue(batch, context)).rejects.toThrow(Crashed);
		await dying.harness.close(context);
		const { instance } = await instanceIn(disk, runtime);
		clock.moveTo(2);
		const { ingress, fired } = await instance.enqueue(batch, context);
		expect({ ingress, fired }).toStrictEqual({ ingress: { kind: "ingress", ...batch, at: 1 }, fired: [] });
		expect(disk.history()).toHaveLength(1);
	});

	test("a commit fires up to stepLimit steps", async () => {
		const { instance } = await opened({ name: "counter", net: counter(stepLimit) });
		const { fired } = await instance.enqueue({ requestId: "start", tokens: { [counted.id]: [0] } }, context);
		expect(fired).toHaveLength(stepLimit);
		expect((await instance.state(context)).marking).toStrictEqual({ [counted.id]: [stepLimit] });
	});

	test("refuses a net that can still fire after stepLimit steps, which is a bug in the net, and commits nothing", async () => {
		const { disk, instance } = await opened({ name: "counter", net: counter(stepLimit + 1) });
		await expect(instance.enqueue({ requestId: "start", tokens: { [counted.id]: [0] } }, context)).rejects.toThrow(
			new Error("the net did not become quiet after 1000 steps"),
		);
		expect(disk.history()).toStrictEqual([]);
	});

	test("refuses a net with problems, which is a bug in the caller, and names every problem", () => {
		const broken = { ...contested, transitions: [...contested.transitions, ...contested.transitions] };
		expect(() => createRuntime({ ...contestedOptions(definitionOrder, createClock()), net: broken })).toThrow(
			new Error("invalid net: take-left: id used 2 times; take-right: id used 2 times"),
		);
	});

	test("refuses a conversation that holds an instance of another net, which is a bug in the host", async () => {
		const clock = createClock();
		const mine = createRuntime(contestedOptions(definitionOrder, clock));
		const other = createRuntime({ ...contestedOptions(definitionOrder, clock), name: "other" });
		const disk = createDisk([mine.extension, other.extension], clock);
		const { process, instance } = await instanceIn(disk, mine);
		await instance.enqueue(batch, context);
		const theirs = other.instance(process.harness, (await process.harness.root(context)).id);
		const wrongNet = new Error("the conversation holds an instance of the net contested, not other");
		await expect(theirs.state(context)).rejects.toThrow(wrongNet);
		await expect(theirs.enqueue({ ...batch, requestId: "delivery-2" }, context)).rejects.toThrow(wrongNet);
		expect(disk.history()).toHaveLength(1);
	});

	test("opens a net instance that an earlier version stored, and still finds its request ids", async () => {
		const clock = createClock(1);
		const runtime = createRuntime(contestedOptions(definitionOrder, clock));
		const disk = createDisk([runtime.extension], clock);
		const earlier = await disk.open();
		const root = await earlier.harness.root(context);
		const ingress = { kind: "ingress", ...batch, at: 1 };
		const fired = { kind: "occurrence", transition: takeLeft, binding: { j: "j1" }, at: 1 };
		await earlier.harness.commit(async (tx) => {
			const draft = await tx.doc(netInstanceRecordVersion1, root.id);
			draft.net = "contested";
			draft.marking = { [left.id]: ["j1"], [ready.id]: ["j2"] };
			draft.log = [{ ...ingress, tokens: { [ready.id]: ["j1", "j2"] } }, fired];
		}, context);
		await earlier.harness.close(context);
		const { instance } = await instanceIn(disk, runtime);
		clock.moveTo(2);
		expect(await instance.enqueue(batch, context)).toStrictEqual({ ingress, fired: [] });
		const next = await instance.enqueue({ requestId: "delivery-2", tokens: { [ready.id]: ["j2"] } }, context);
		expect(next.ingress).toStrictEqual({
			kind: "ingress",
			requestId: "delivery-2",
			tokens: { [ready.id]: ["j2"] },
			at: 2,
		});
		expect(await instance.enqueue(batch, context)).toStrictEqual({ ingress, fired: [] });
	});

	test("on a new process, finds the recorded ingress of a request id that names a property of every object", async () => {
		const clock = createClock(1);
		const runtime = createRuntime(contestedOptions(definitionOrder, clock));
		const disk = createDisk([runtime.extension], clock);
		const batches = ["__proto__", "constructor", "toString"].map((requestId) => ({ ...batch, requestId }));
		const earlier = await disk.open();
		const first = runtime.instance(earlier.harness, (await earlier.harness.root(context)).id);
		const ingresses = [];
		for (const sent of batches) {
			ingresses.push((await first.enqueue(sent, context)).ingress);
		}
		await earlier.harness.close(context);
		const { instance } = await instanceIn(disk, runtime);
		clock.moveTo(2);
		for (const [index, sent] of batches.entries()) {
			expect(await instance.enqueue(sent, context)).toStrictEqual({ ingress: ingresses[index], fired: [] });
		}
		expect(disk.history()).toHaveLength(batches.length);
	});

	test("refuses a stored marking that does not fit the net, which is a bug in the store", async () => {
		const { process, instance } = await opened();
		const root = await process.harness.root(context);
		await process.harness.commit(async (tx) => {
			const draft = await tx.doc(netInstanceRecord, root.id);
			draft.net = "contested";
			draft.marking = { [ready.id]: ["j9"], lost: ["j1"] };
		}, context);
		const problems = new Error(
			'invalid stored marking: marking: "j9" on ready is not in Job; marking: place lost is not in the net',
		);
		await expect(instance.state(context)).rejects.toThrow(problems);
		await expect(instance.enqueue(batch, context)).rejects.toThrow(problems);
	});

	test("rejects an enqueue whose net throws, and commits nothing", async () => {
		const takeLeftBroken = {
			...move("take-left", ready, left),
			outputs: [{ place: left, expression: () => ["j9"] }],
		};
		const { disk, instance } = await opened({ net: { ...contested, transitions: [takeLeftBroken] } });
		await expect(instance.enqueue(batch, context)).rejects.toThrow(TypeError);
		expect(disk.history()).toStrictEqual([]);
		expect(await instance.state(context)).toStrictEqual({ marking: {}, log: [] });
	});

	test("rejects an enqueue whose policy names a transition outside the net, and commits nothing", async () => {
		const invents: SelectionPolicy = () => [{ transition: transitionId("ghost"), binding: {} }];
		const { disk, instance } = await opened({ policy: invents });
		await expect(instance.enqueue(batch, context)).rejects.toThrow(
			"the policy chose ghost, which is not a transition of the net",
		);
		expect(disk.history()).toStrictEqual([]);
	});

	test("rejects a batch that does not fit the net, which is a bug in the host, and commits nothing", async () => {
		const { disk, instance } = await opened();
		await expect(
			instance.enqueue({ requestId: "delivery-1", tokens: { [ready.id]: ["j9"], [placeId("lost")]: [] } }, context),
		).rejects.toThrow(
			'invalid batch delivery-1: marking: "j9" on ready is not in Job; marking: place lost is not in the net',
		);
		expect(disk.history()).toStrictEqual([]);
	});
});

describe("createRuntime, simulation", () => {
	test("adds each batch once and leaves every commit quiet when a crash cuts any commit and the host sends every batch again", async () => {
		await fc.assert(crashProperty(createRuntime));
	});

	test("loses no acknowledged batch and adds each request id once under any order of concurrent enqueues", async () => {
		await fc.assert(raceProperty(createRuntime));
	});
});
