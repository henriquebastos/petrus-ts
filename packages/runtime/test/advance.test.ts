import type { Marking, SelectionPolicy } from "@petrus/petri-net";
import { definitionOrder, placeId, transitionId } from "@petrus/petri-net";
import { describe, expect, test } from "vitest";
import type { Occurrence } from "../src/index.ts";
import { advance, advanceUntilQuiet, stepLimit } from "../src/advance.ts";
import { BrokenNetInstance } from "../src/net-instance.ts";
import { contested, counted, counter, initialState } from "./properties.ts";

describe("advance", () => {
	test("fires the step and returns its occurrences, each stamped with the given time, and the marking after it", () => {
		const fired = [
			{ kind: "occurrence", transition: transitionId("take-left"), binding: { j: "j1" }, at: 7 },
			{ kind: "occurrence", transition: transitionId("take-left"), binding: { j: "j2" }, at: 7 },
		];
		expect(advance(contested, definitionOrder, initialState.marking, 7)).toStrictEqual({
			fired,
			marking: { [placeId("left")]: ["j1", "j2"] },
		});
	});

	test("returns the same marking when nothing fires, so the runtime commits nothing", () => {
		const idle: Marking = { [placeId("right")]: ["j1"] };
		const stepped = advance(contested, definitionOrder, idle, 7);
		expect(stepped.fired).toStrictEqual([]);
		expect(stepped.marking).toBe(idle);
	});
});

describe("advanceUntilQuiet", () => {
	test("steps until the policy selects nothing and returns every occurrence in firing order", () => {
		const one: SelectionPolicy = (enabled) => enabled.slice(0, 1);
		const stepped = advanceUntilQuiet(counter(3), one, { [counted.id]: [0] }, 7);
		const tick = (n: number): Occurrence => ({
			kind: "occurrence",
			transition: transitionId("tick"),
			binding: { n },
			at: 7,
		});
		expect(stepped).toStrictEqual({ fired: [tick(0), tick(1), tick(2)], marking: { [counted.id]: [3] } });
		expect(advanceUntilQuiet(counter(3), one, stepped.marking, 8)).toStrictEqual({
			fired: [],
			marking: stepped.marking,
		});
	});

	test("fires up to stepLimit steps, and throws for a net that can still fire after them, which is a bug in the net", () => {
		const start: Marking = { [counted.id]: [0] };
		expect(advanceUntilQuiet(counter(stepLimit), definitionOrder, start, 7).fired).toHaveLength(stepLimit);
		expect(() => advanceUntilQuiet(counter(stepLimit + 1), definitionOrder, start, 7)).toThrow(
			new BrokenNetInstance("the net did not become quiet after 1000 steps"),
		);
	});
});
