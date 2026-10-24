import fc from "fast-check";
import { placeId, transitionId } from "@petrus/petri-net";
import { describe, expect, test } from "vitest";
import { createRuntime } from "../src/index.ts";
import { createDisk } from "./controlled-store.ts";
import { contested, crashCutProperty, initialState, left, move, raceProperty, ready } from "./properties.ts";

const takeLeft = transitionId("take-left");

describe("createRuntime, examples", () => {
	test("commits the new marking and the occurrence together, stamped by the clock", async () => {
		const disk = createDisk(initialState);
		let clock = 5_000;
		const runtime = createRuntime({ net: contested, store: disk.open(), clock: { now: () => clock } });
		clock = 6_000;
		const result = await runtime.step(takeLeft, { j: "j1" });
		expect(result.ok).toBe(true);
		expect(disk.stored()).toStrictEqual({
			marking: { [placeId("ready")]: ["j2"], [placeId("left")]: ["j1"] },
			occurrences: [{ transition: takeLeft, binding: { j: "j1" }, at: 6_000 }],
		});
	});

	test("returns not-enabled and commits nothing when the token is gone", async () => {
		const disk = createDisk({ marking: { [placeId("ready")]: ["j2"] }, occurrences: [] });
		const runtime = createRuntime({ net: contested, store: disk.open(), clock: { now: () => 0 } });
		const result = await runtime.step(takeLeft, { j: "j1" });
		expect(result.ok ? undefined : result.error.kind).toBe("not-enabled");
		expect(disk.stored()).toStrictEqual({ marking: { [placeId("ready")]: ["j2"] }, occurrences: [] });
	});

	test("returns not-a-binding and commits nothing for a value outside the colour set", async () => {
		const disk = createDisk(initialState);
		const runtime = createRuntime({ net: contested, store: disk.open(), clock: { now: () => 0 } });
		const result = await runtime.step(takeLeft, { j: "j9" });
		expect(result).toStrictEqual({
			ok: false,
			error: { kind: "not-a-binding", transition: takeLeft, problems: ['take-left: j = "j9" is not in Job'] },
		});
		expect(disk.stored()).toBe(initialState);
	});

	test("returns unknown-transition for an id that is not in the net", async () => {
		const runtime = createRuntime({
			net: contested,
			store: createDisk(initialState).open(),
			clock: { now: () => 0 },
		});
		const result = await runtime.step(transitionId("missing"), {});
		expect(result).toStrictEqual({ ok: false, error: { kind: "unknown-transition", transition: "missing" } });
	});

	test("refuses a net with problems, which is a bug in the caller, and names every problem", () => {
		const broken = { ...contested, transitions: [...contested.transitions, ...contested.transitions.slice(0, 2)] };
		expect(() =>
			createRuntime({ net: broken, store: createDisk(initialState).open(), clock: { now: () => 0 } }),
		).toThrow(new Error("invalid net: take-left: id used 2 times; take-right: id used 2 times"));
	});

	test("rejects a step when the stored marking does not fit the net, which is a bug in the store", async () => {
		const disk = createDisk({ marking: { [placeId("ready")]: ["j9"], [placeId("lost")]: ["j1"] }, occurrences: [] });
		const runtime = createRuntime({ net: contested, store: disk.open(), clock: { now: () => 0 } });
		await expect(runtime.step(takeLeft, { j: "j1" })).rejects.toThrow(
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
		const runtime = createRuntime({
			net: { ...contested, transitions: [takeLeftBroken] },
			store: disk.open(),
			clock: { now: () => 0 },
		});
		await expect(runtime.step(takeLeft, { j: "j1" })).rejects.toThrow(TypeError);
		expect(disk.stored()).toBe(initialState);
	});

	test("a failed commit does not block the next step", async () => {
		const disk = createDisk(initialState);
		const runtime = createRuntime({
			net: contested,
			store: disk.open({ crashAtCommit: 0 }),
			clock: { now: () => 0 },
		});
		await expect(runtime.step(takeLeft, { j: "j1" })).rejects.toThrow("crash at commit 0");
		// The queue runs the next step; it fails only because the crashed store is closed.
		await expect(runtime.step(takeLeft, { j: "j1" })).rejects.toThrow("store is closed");
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
