import fc from "fast-check";
import type { SelectionPolicy } from "@petrus/petri-net";
import { definitionOrder, placeId, transitionId } from "@petrus/petri-net";
import { describe, expect, test } from "vitest";
import type { RuntimeOptions } from "../src/index.ts";
import { createRuntime } from "../src/index.ts";
import type { Disk } from "./controlled-store.ts";
import { createDisk, ReplyLost } from "./controlled-store.ts";
import {
	contested,
	crashCutProperty,
	initialState,
	left,
	move,
	raceProperty,
	ready,
	retryProperty,
} from "./properties.ts";

const takeLeft = transitionId("take-left");
const takeRight = transitionId("take-right");

function options(disk: Disk, overrides: Partial<RuntimeOptions> = {}): RuntimeOptions {
	return { net: contested, store: disk.open(), policy: definitionOrder, clock: { now: () => 0 }, ...overrides };
}

describe("createRuntime, examples", () => {
	test("commits the new marking and the step's occurrences together, stamped by the clock", async () => {
		const disk = createDisk(initialState);
		let clock = 5_000;
		const runtime = createRuntime(options(disk, { clock: { now: () => clock } }));
		clock = 6_000;
		const fired = [
			{ kind: "occurrence", transition: takeLeft, binding: { j: "j1" }, at: 6_000 },
			{ kind: "occurrence", transition: takeLeft, binding: { j: "j2" }, at: 6_000 },
		];
		const stepped = await runtime.step();
		expect(stepped.fired).toStrictEqual(fired);
		expect(disk.stored()).toStrictEqual({ marking: { [placeId("left")]: ["j1", "j2"] }, log: fired });
		expect(stepped.state).toStrictEqual(disk.stored());
	});

	test("lets the policy decide which transition takes a contested token", async () => {
		const disk = createDisk(initialState);
		const rightFirst: SelectionPolicy = (enabled) => enabled.filter((element) => element.transition === takeRight);
		const stepped = await createRuntime(options(disk, { policy: rightFirst })).step();
		expect(stepped.fired.map((occurrence) => occurrence.transition)).toStrictEqual([takeRight, takeRight]);
		expect(disk.stored().marking).toStrictEqual({ [placeId("right")]: ["j1", "j2"] });
	});

	test("fires nothing and commits nothing when nothing is enabled", async () => {
		const idle = { marking: { [placeId("right")]: ["j1"] }, log: [] };
		let commits = 0;
		const disk = createDisk(idle);
		const store = disk.open();
		const runtime = createRuntime(
			options(disk, {
				store: {
					load: store.load,
					commit: (state) => {
						commits += 1;
						return store.commit(state);
					},
				},
			}),
		);
		expect(await runtime.step()).toStrictEqual({ fired: [], state: idle });
		expect(commits).toBe(0);
	});

	test("refuses a net with problems, which is a bug in the caller, and names every problem", () => {
		const broken = { ...contested, transitions: [...contested.transitions, ...contested.transitions.slice(0, 2)] };
		expect(() => createRuntime(options(createDisk(initialState), { net: broken }))).toThrow(
			new Error("invalid net: take-left: id used 2 times; take-right: id used 2 times"),
		);
	});

	test("rejects a step and an enqueue when the stored marking does not fit the net, which is a bug in the store", async () => {
		const disk = createDisk({ marking: { [placeId("ready")]: ["j9"], [placeId("lost")]: ["j1"] }, log: [] });
		const runtime = createRuntime(options(disk));
		const problems = new Error(
			'invalid stored marking: marking: "j9" on ready is not in Job; marking: place lost is not in the net',
		);
		await expect(runtime.step()).rejects.toThrow(problems);
		await expect(runtime.enqueue({ requestId: "delivery-1", tokens: { [ready.id]: ["j1"] } })).rejects.toThrow(
			problems,
		);
	});

	test("rejects a step whose net throws, and commits nothing", async () => {
		const takeLeftBroken = {
			...move("take-left", ready, left),
			outputs: [{ place: left, expression: () => ["j9"] }],
		};
		const disk = createDisk(initialState);
		const runtime = createRuntime(options(disk, { net: { ...contested, transitions: [takeLeftBroken] } }));
		await expect(runtime.step()).rejects.toThrow(TypeError);
		expect(disk.stored()).toBe(initialState);
	});

	test("rejects a step whose policy names a transition outside the net, and commits nothing", async () => {
		const disk = createDisk(initialState);
		const invents: SelectionPolicy = () => [{ transition: transitionId("ghost"), binding: {} }];
		await expect(createRuntime(options(disk, { policy: invents })).step()).rejects.toThrow(
			"the policy chose ghost, which is not a transition of the net",
		);
		expect(disk.stored()).toBe(initialState);
	});

	test("enqueues a batch: commits its tokens and its ingress together, stamped by the clock", async () => {
		const disk = createDisk({ marking: {}, log: [] });
		const runtime = createRuntime(options(disk, { clock: { now: () => 9 } }));
		const ingress = await runtime.enqueue({ requestId: "delivery-1", tokens: { [ready.id]: ["j2"] } });
		expect(ingress).toStrictEqual({
			kind: "ingress",
			requestId: "delivery-1",
			tokens: { [ready.id]: ["j2"] },
			at: 9,
		});
		expect(disk.stored()).toStrictEqual({ marking: { [ready.id]: ["j2"] }, log: [ingress] });
	});

	test("a retry after a lost reply returns the recorded ingress and adds nothing", async () => {
		const disk = createDisk(initialState);
		let clock = 1;
		const runtime = createRuntime(
			options(disk, { store: disk.open({ loseReplyAtCommit: 0 }), clock: { now: () => clock } }),
		);
		const batch = { requestId: "delivery-1", tokens: { [ready.id]: ["j1"] } };
		await expect(runtime.enqueue(batch)).rejects.toThrow(ReplyLost);
		const landed = disk.stored();
		clock = 2;
		expect(await runtime.enqueue(batch)).toStrictEqual({ kind: "ingress", ...batch, at: 1 });
		expect(disk.stored()).toBe(landed);
	});

	test("rejects a batch that does not fit the net, which is a bug in the host, and commits nothing", async () => {
		const disk = createDisk(initialState);
		await expect(
			createRuntime(options(disk)).enqueue({ requestId: "delivery-1", tokens: { [ready.id]: ["j9"] } }),
		).rejects.toThrow('invalid batch delivery-1: marking: "j9" on ready is not in Job');
		expect(disk.stored()).toBe(initialState);
	});

	test("a failed commit does not block the next step", async () => {
		const disk = createDisk(initialState);
		const runtime = createRuntime(options(disk, { store: disk.open({ crashAtCommit: 0 }) }));
		await expect(runtime.step()).rejects.toThrow("crash at commit 0");
		// The queue runs the next step; it fails only because the crashed store is closed.
		await expect(runtime.step()).rejects.toThrow("store is closed");
	});
});

describe("createRuntime, simulation", () => {
	test("stays consistent after a crash at any commit and a reopen", async () => {
		await fc.assert(crashCutProperty(createRuntime));
	});

	test("loses no acknowledged step or batch under any interleaving", async () => {
		await fc.assert(raceProperty(createRuntime));
	});

	test("adds each batch once when a commit fails or its reply is lost and the host retries with the same request id", async () => {
		await fc.assert(retryProperty(createRuntime));
	});
});
