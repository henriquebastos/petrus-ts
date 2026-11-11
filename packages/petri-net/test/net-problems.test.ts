import { describe, expect, test } from "vitest";
import type { ColourSet, Net, Place, Transition } from "../src/index.ts";
import { markingProblems, netProblems, placeId, transitionId } from "../src/index.ts";

const number: ColourSet = { name: "Number", contains: (token) => typeof token === "number" };
const text: ColourSet = { name: "Text", contains: (token) => typeof token === "string" };
const a: Place = { id: placeId("a"), colourSet: number };
const b: Place = { id: placeId("b"), colourSet: text };

function move(id: string): Transition<"x"> {
	return {
		id: transitionId(id),
		variables: { x: number },
		guard: () => true,
		inputs: [{ place: a, variables: ["x"] }],
		outputs: [{ place: a, expression: ({ x }) => [x] }],
	};
}

const net: Net = { places: [a, b], transitions: [move("t1"), move("t2")] };

describe("netProblems", () => {
	test("a net with unique ids, declared places and consistent variables has no problem", () => {
		expect(netProblems(net)).toStrictEqual([]);
	});

	test("reports an id used twice", () => {
		expect(netProblems({ places: [a, a, b], transitions: [move("t1"), move("t1")] })).toStrictEqual([
			"a: id used 2 times",
			"t1: id used 2 times",
		]);
	});

	test("reports a join key for an undeclared variable", () => {
		const wrong: Transition = { ...move("joined"), joinKeys: { ghost: () => "", x: () => "" } };
		expect(netProblems({ places: [a], transitions: [wrong] })).toStrictEqual([
			"joined: joinKeys variable ghost is not declared",
		]);
		expect(
			netProblems({ places: [a], transitions: [{ ...move("joined"), joinKeys: { x: () => "" } }] }),
		).toStrictEqual([]);
	});

	test("reports an arc to a place that is not in the net", () => {
		const elsewhere: Place = { id: placeId("elsewhere"), colourSet: number };
		const lost: Transition<"x"> = { ...move("lost"), outputs: [{ place: elsewhere, expression: () => [] }] };
		expect(netProblems({ places: [a], transitions: [lost] })).toStrictEqual([
			"lost: place elsewhere is not in the net",
		]);
	});

	test("reports a variable that is undeclared, on no variable input arc, or of another colour set than its place", () => {
		const wrong: Transition = {
			id: transitionId("wrong"),
			variables: { x: number, unused: number, y: number },
			guard: () => true,
			inputs: [
				{ place: a, variables: ["x", "ghost"] },
				{ place: b, variables: ["y"] },
			],
			outputs: [],
		};
		expect(netProblems({ places: [a, b], transitions: [wrong] })).toStrictEqual([
			"wrong: variable unused is on no variable input arc",
			"wrong: variable ghost on a is not declared",
			"wrong: variable y has colour set Number, place b has Text",
		]);
	});

	test("checks variables on variable input arcs only, and checks the place of an expression input arc", () => {
		const elsewhere: Place = { id: placeId("elsewhere"), colourSet: number };
		const computed: Transition<"x" | "y"> = {
			id: transitionId("computed"),
			variables: { x: number, y: number },
			guard: () => true,
			inputs: [
				{ place: a, variables: ["x"] },
				{ place: b, expression: ({ x, y }) => [x, y] },
				{ place: elsewhere, expression: () => [] },
			],
			outputs: [],
		};
		expect(netProblems({ places: [a, b], transitions: [computed] })).toStrictEqual([
			"computed: place elsewhere is not in the net",
			"computed: variable y is on no variable input arc",
		]);
	});
});

describe("markingProblems", () => {
	test("a marking of the net's places with tokens of their colour sets has no problem", () => {
		expect(markingProblems(net, { [a.id]: [1, 2], [b.id]: ["x"] })).toStrictEqual([]);
	});

	test("reports a place outside the net, an empty place, and a token outside its colour set", () => {
		expect(markingProblems(net, { [placeId("c")]: [1], [a.id]: [1, "one"], [b.id]: [] })).toStrictEqual([
			"marking: place c is not in the net",
			'marking: "one" on a is not in Number',
			"marking: place b is listed with no tokens",
		]);
	});
});
