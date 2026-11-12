import fc from "fast-check";
import type { SelectionPolicy } from "@petrus/petri-net";
import { definitionOrder, placeId, transitionId } from "@petrus/petri-net";
import { describe, expect, onTestFinished, test } from "vitest";
import type { NetInstance, Runtime, RuntimeOptions } from "../src/index.ts";
import { busyPlaceId, createRuntime } from "../src/index.ts";
import { netInstanceRecord } from "../src/net-instance-record.ts";
import { BrokenNetInstance } from "../src/net-instance.ts";
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
		const state = { marking: { [busyPlaceId(takeLeft)]: [{ j: "j1" }, { j: "j2" }] }, log: [ingress, ...fired] };
		expect(await instance.state(context)).toStrictEqual(state);
		expect(disk.history()).toStrictEqual([state]);
	});

	test("lets the policy decide which transition takes a contested token", async () => {
		const rightOnly: SelectionPolicy = (enabled) => enabled.filter((element) => element.transition === takeRight);
		const { instance } = await opened({ policy: rightOnly });
		const { fired } = await instance.enqueue(batch, context);
		expect(fired.map((occurrence) => occurrence.transition)).toStrictEqual([takeRight, takeRight]);
		expect((await instance.state(context)).marking).toStrictEqual({
			[busyPlaceId(takeRight)]: [{ j: "j1" }, { j: "j2" }],
		});
	});

	test("a commit steps until the net is quiet: a policy that fires one element a step still fires them all", async () => {
		const { disk, instance } = await opened({ policy: (enabled) => enabled.slice(0, 1) });
		const { fired } = await instance.enqueue(batch, context);
		expect(fired.map((occurrence) => occurrence.binding)).toStrictEqual([{ j: "j1" }, { j: "j2" }]);
		expect(disk.history().map((state) => state.marking)).toStrictEqual([
			{ [busyPlaceId(takeLeft)]: [{ j: "j1" }, { j: "j2" }] },
		]);
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

	test("plain transitions reserve inputs before their native executions produce outputs", async () => {
		const { process, instance } = await opened({ name: "counter", net: counter(3), startLimit: 3 });
		const { fired } = await instance.enqueue({ requestId: "start", tokens: { [counted.id]: [0] } }, context);
		expect(fired).toHaveLength(1);
		expect((await instance.state(context)).marking).toStrictEqual({ [placeId("tick:busy")]: [{ n: 0 }] });
		await process.settle();
		expect((await instance.state(context)).marking).toStrictEqual({ [counted.id]: [3] });
		expect(await instance.inFlight(context)).toStrictEqual([]);
	});

	test("a cycle pauses at its durable start ceiling and resumes after an explicit increase", async () => {
		const { disk, process, instance } = await opened({ name: "counter", net: counter(4), startLimit: 3 });
		await instance.enqueue({ requestId: "start", tokens: { [counted.id]: [0] } }, context);
		await process.settle();
		expect(await instance.budget(context)).toStrictEqual({ ceiling: 3, used: 3, paused: true });
		expect((await instance.state(context)).marking).toStrictEqual({ [counted.id]: [3] });
		await instance.raiseStartLimit(4, context);
		await process.settle();
		expect((await instance.state(context)).marking).toStrictEqual({ [counted.id]: [4] });
		expect(disk.reports()).toStrictEqual([]);
	});

	test("refuses a net with problems, which is a bug in the caller, and names every problem", () => {
		const broken = { ...contested, transitions: [...contested.transitions, ...contested.transitions] };
		expect(() => createRuntime({ ...contestedOptions(definitionOrder, createClock()), net: broken })).toThrow(
			new Error(
				"invalid net: take-left:busy: id used 2 times; take-left:result: id used 2 times; take-right:busy: id used 2 times; take-right:result: id used 2 times; take-left: id used 2 times; take-left:done: id used 2 times; take-right: id used 2 times; take-right:done: id used 2 times",
			),
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
		const wrongNet = new BrokenNetInstance("the conversation holds an instance of the net contested, not other");
		await expect(theirs.state(context)).rejects.toThrow(wrongNet);
		await expect(theirs.enqueue({ ...batch, requestId: "delivery-2" }, context)).rejects.toThrow(wrongNet);
		expect(disk.history()).toHaveLength(1);
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
		const problems = new BrokenNetInstance(
			'invalid stored marking: marking: "j9" on ready is not in Job; marking: place lost is not in the net',
		);
		await expect(instance.state(context)).rejects.toThrow(problems);
		await expect(instance.enqueue(batch, context)).rejects.toThrow(problems);
	});

	test("an invalid plain output faults settlement and preserves the reserved binding", async () => {
		const takeLeftBroken = {
			...move("take-left", ready, left),
			outputs: [{ place: left, expression: () => ["j9"] }],
		};
		const { disk, process, instance } = await opened({ net: { ...contested, transitions: [takeLeftBroken] } });
		await instance.enqueue(batch, context);
		const reserved = await instance.state(context);
		await process.settle();
		expect(disk.reports()).toHaveLength(2);
		expect(disk.reports().every((error) => error instanceof TypeError)).toBe(true);
		expect(await instance.state(context)).toStrictEqual(reserved);
		expect(await instance.inFlight(context)).toHaveLength(2);
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
