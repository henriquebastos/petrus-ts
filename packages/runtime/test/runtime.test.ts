import fc from "fast-check";
import { placeId, transitionId } from "@petrus/petri-net";
import { describe, expect, test } from "vitest";
import { createRuntime } from "../src/index.ts";
import { createDisk } from "./controlled-store.ts";
import { contested, crashCutProperty, initialState, raceProperty } from "./properties.ts";

describe("createRuntime, examples", () => {
	test("commits the new marking and the occurrence together, stamped by the clock", async () => {
		const disk = createDisk(initialState);
		let clock = 5_000;
		const runtime = createRuntime({ transitions: contested, store: disk.open(), clock: { now: () => clock } });
		clock = 6_000;
		const result = await runtime.step(transitionId("take-left"));
		expect(result.ok).toBe(true);
		expect(disk.stored()).toStrictEqual({
			marking: { [placeId("left")]: 1 },
			occurrences: [{ transition: transitionId("take-left"), at: 6_000 }],
		});
	});

	test("returns not-enabled and commits nothing when the token is gone", async () => {
		const disk = createDisk({ marking: {}, occurrences: [] });
		const runtime = createRuntime({ transitions: contested, store: disk.open(), clock: { now: () => 0 } });
		const result = await runtime.step(transitionId("take-left"));
		expect(result.ok ? undefined : result.error.kind).toBe("not-enabled");
		expect(disk.stored()).toStrictEqual({ marking: {}, occurrences: [] });
	});

	test("returns unknown-transition for an id that is not in the net", async () => {
		const runtime = createRuntime({
			transitions: contested,
			store: createDisk(initialState).open(),
			clock: { now: () => 0 },
		});
		const result = await runtime.step(transitionId("missing"));
		expect(result).toStrictEqual({ ok: false, error: { kind: "unknown-transition", transition: "missing" } });
	});

	test("refuses a net with problems, which is a bug in the caller, and names every problem", () => {
		const broken = [...contested, ...contested.slice(0, 2)];
		expect(() =>
			createRuntime({ transitions: broken, store: createDisk(initialState).open(), clock: { now: () => 0 } }),
		).toThrow(new Error("invalid net: take-left: id used 2 times; take-right: id used 2 times"));
	});

	test("a failed commit does not block the next step", async () => {
		const disk = createDisk(initialState);
		const runtime = createRuntime({
			transitions: contested,
			store: disk.open({ crashAtCommit: 0 }),
			clock: { now: () => 0 },
		});
		await expect(runtime.step(transitionId("take-left"))).rejects.toThrow("crash at commit 0");
		// The queue runs the next step; it fails only because the crashed store is closed.
		await expect(runtime.step(transitionId("take-left"))).rejects.toThrow("store is closed");
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
