import { describe, expect, test } from "vitest";
import type { Transition } from "../src/index.ts";
import { netProblems, placeId, transitionId } from "../src/index.ts";

const a = placeId("a");

function transition(id: string, weight: number): Transition {
	return { id: transitionId(id), inputs: [{ place: a, weight }], outputs: [{ place: a, weight: 1 }] };
}

describe("netProblems", () => {
	test("a net with unique ids and positive integer weights has no problem", () => {
		expect(netProblems([transition("t1", 1), transition("t2", 3)])).toStrictEqual([]);
	});

	test("reports each weight that is not a positive integer", () => {
		expect(netProblems([transition("zero", 0), transition("negative", -1), transition("half", 0.5)])).toStrictEqual([
			"zero: weight 0 on a is not a positive integer",
			"negative: weight -1 on a is not a positive integer",
			"half: weight 0.5 on a is not a positive integer",
		]);
	});

	test("reports an id used by more than one transition", () => {
		expect(netProblems([transition("t1", 1), transition("t1", 2)])).toStrictEqual(["t1: id used 2 times"]);
	});
});
