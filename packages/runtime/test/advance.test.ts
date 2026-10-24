import type { SelectionPolicy } from "@petrus/petri-net";
import { definitionOrder, placeId, transitionId } from "@petrus/petri-net";
import { describe, expect, test } from "vitest";
import type { NetInstanceState, Occurrence } from "../src/index.ts";
import { advance, advanceUntilQuiet, stepLimit } from "../src/advance.ts";
import { contested, counted, counter, initialState } from "./properties.ts";

describe("advance", () => {
	test("appends the step's occurrences to the log, each stamped with the given time", () => {
		const earlier = {
			kind: "occurrence" as const,
			transition: transitionId("give-back"),
			binding: { j: "j3" },
			at: 1,
		};
		const state: NetInstanceState = { ...initialState, log: [earlier] };
		const fired = [
			{ kind: "occurrence", transition: transitionId("take-left"), binding: { j: "j1" }, at: 7 },
			{ kind: "occurrence", transition: transitionId("take-left"), binding: { j: "j2" }, at: 7 },
		];
		expect(advance(contested, definitionOrder, state, 7)).toStrictEqual({
			fired,
			state: { marking: { [placeId("left")]: ["j1", "j2"] }, log: [earlier, ...fired] },
		});
		expect(state.log).toStrictEqual([earlier]);
	});

	test("returns the same state when nothing fires, so the runtime commits nothing", () => {
		const idle: NetInstanceState = { marking: { [placeId("right")]: ["j1"] }, log: [] };
		const stepped = advance(contested, definitionOrder, idle, 7);
		expect(stepped.fired).toStrictEqual([]);
		expect(stepped.state).toBe(idle);
	});
});

describe("advanceUntilQuiet", () => {
	test("steps until the policy selects nothing and returns every occurrence in firing order", () => {
		const one: SelectionPolicy = (enabled) => enabled.slice(0, 1);
		const stepped = advanceUntilQuiet(counter(3), one, { marking: { [counted.id]: [0] }, log: [] }, 7);
		const tick = (n: number): Occurrence => ({
			kind: "occurrence",
			transition: transitionId("tick"),
			binding: { n },
			at: 7,
		});
		expect(stepped).toStrictEqual({
			fired: [tick(0), tick(1), tick(2)],
			state: { marking: { [counted.id]: [3] }, log: [tick(0), tick(1), tick(2)] },
		});
		expect(advanceUntilQuiet(counter(3), one, stepped.state, 8)).toStrictEqual({ fired: [], state: stepped.state });
	});

	test("fires up to stepLimit steps, and throws for a net that can still fire after them, which is a bug in the net", () => {
		const start: NetInstanceState = { marking: { [counted.id]: [0] }, log: [] };
		expect(advanceUntilQuiet(counter(stepLimit), definitionOrder, start, 7).fired).toHaveLength(stepLimit);
		expect(() => advanceUntilQuiet(counter(stepLimit + 1), definitionOrder, start, 7)).toThrow(
			new Error("the net did not become quiet after 1000 steps"),
		);
	});
});
