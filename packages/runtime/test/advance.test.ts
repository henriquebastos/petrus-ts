import type { Marking, SelectionPolicy } from "@petrus/petri-net";
import { definitionOrder, indexMarking, markingOfIndexed, placeId, transitionId } from "@petrus/petri-net";
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
		const stepped = advance(definitionOrder, indexMarking(contested, initialState.marking), 7);
		expect({ fired: stepped.fired, marking: markingOfIndexed(stepped.indexed) }).toStrictEqual({
			fired,
			marking: { [placeId("left")]: ["j1", "j2"] },
		});
	});

	test("returns the same marking when nothing fires, so the runtime commits nothing", () => {
		const idle: Marking = { [placeId("right")]: ["j1"] };
		const indexed = indexMarking(contested, idle);
		const stepped = advance(definitionOrder, indexed, 7);
		expect(stepped.fired).toStrictEqual([]);
		expect(stepped.indexed.journal).toStrictEqual([]);
		expect(markingOfIndexed(stepped.indexed)).toStrictEqual(idle);
	});
});

describe("advanceUntilQuiet", () => {
	test("steps until the policy selects nothing and returns every occurrence in firing order", () => {
		const one: SelectionPolicy = (enabled) => enabled.slice(0, 1);
		const stepped = advanceUntilQuiet(one, indexMarking(counter(3), { [counted.id]: [0] }), 7);
		const tick = (n: number): Occurrence => ({
			kind: "occurrence",
			transition: transitionId("tick"),
			binding: { n },
			at: 7,
		});
		expect({ fired: stepped.fired, marking: markingOfIndexed(stepped.indexed) }).toStrictEqual({
			fired: [tick(0), tick(1), tick(2)],
			marking: { [counted.id]: [3] },
		});
		const quiet = advanceUntilQuiet(one, stepped.indexed, 8);
		expect({ fired: quiet.fired, marking: markingOfIndexed(quiet.indexed) }).toStrictEqual({
			fired: [],
			marking: { [counted.id]: [3] },
		});
	});

	test("fires up to stepLimit steps, and throws for a net that can still fire after them, which is a bug in the net", () => {
		const start: Marking = { [counted.id]: [0] };
		expect(advanceUntilQuiet(definitionOrder, indexMarking(counter(stepLimit), start), 7).fired).toHaveLength(
			stepLimit,
		);
		expect(() => advanceUntilQuiet(definitionOrder, indexMarking(counter(stepLimit + 1), start), 7)).toThrow(
			new BrokenNetInstance("the net did not become quiet after 1000 steps"),
		);
	});
});
