import fc from "fast-check";
import type { SelectionPolicy } from "@petrus/petri-net";
import { definitionOrder, placeId, transitionId } from "@petrus/petri-net";
import { describe, expect, test } from "vitest";
import type { RuntimeOptions } from "../src/index.ts";
import { createRuntime } from "../src/index.ts";
import type { Disk } from "./controlled-store.ts";
import { createDisk } from "./controlled-store.ts";
import { contested, crashCutProperty, initialState, left, move, raceProperty, ready } from "./properties.ts";

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
			{ transition: takeLeft, binding: { j: "j1" }, at: 6_000 },
			{ transition: takeLeft, binding: { j: "j2" }, at: 6_000 },
		];
		const stepped = await runtime.step();
		expect(stepped.fired).toStrictEqual(fired);
		expect(disk.stored()).toStrictEqual({ marking: { [placeId("left")]: ["j1", "j2"] }, occurrences: fired });
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
		const idle = { marking: { [placeId("right")]: ["j1"] }, occurrences: [] };
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

	test("rejects a step when the stored marking does not fit the net, which is a bug in the store", async () => {
		const disk = createDisk({ marking: { [placeId("ready")]: ["j9"], [placeId("lost")]: ["j1"] }, occurrences: [] });
		await expect(createRuntime(options(disk)).step()).rejects.toThrow(
			new Error(
				'invalid stored marking: marking: "j9" on ready is not in Job; marking: place lost is not in the net',
			),
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

	test("loses no acknowledged step under any interleaving", async () => {
		await fc.assert(raceProperty(createRuntime));
	});
});
