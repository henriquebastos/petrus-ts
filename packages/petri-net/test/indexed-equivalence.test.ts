import fc from "fast-check";
import { expect, test } from "vitest";
import type { Marking, Net, SelectionPolicy } from "../src/index.ts";
import { addTokens, enabledElements, fireStep, markingProblems, placeId, transitionId } from "../src/index.ts";
import { markingArbitrary, netArbitrary, policyArbitrary } from "./arbitraries.ts";
import { addTokensIndexed, enabledElementsIndexed, indexMarking, markingOfIndexed, stepIndexed } from "../src/index.ts";

type Operation =
	| { readonly kind: "step"; readonly policy: SelectionPolicy }
	| { readonly kind: "add"; readonly marking: Marking };
const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
	fc.record({ kind: fc.constant("step"), policy: policyArbitrary }),
	fc.record({ kind: fc.constant("add"), marking: markingArbitrary }),
);
const operationsArbitrary = fc.array(operationArbitrary, { minLength: 20, maxLength: 30 });
type Indexed = ReturnType<typeof indexMarking>;

/** Strict equality alone ignores object key order, which the stored log preserves. */
function exact(actual: unknown, expected: unknown): void {
	expect(entries(actual)).toStrictEqual(entries(expected));
	expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

/** Vitest treats an own `constructor` as a class constructor, so compare records as entries. */
function entries(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(entries);
	if (typeof value === "object" && value !== null) {
		return { entries: Object.entries(value).map(([key, item]) => [key, entries(item)]) };
	}
	return value;
}

function sameState(net: Net, marking: Marking, indexed: Indexed): void {
	exact(markingOfIndexed(indexed), marking);
	expect(Object.keys(markingOfIndexed(indexed))).toStrictEqual(Object.keys(marking));
	exact(enabledElementsIndexed(indexed), enabledElements(net, marking));
	expect(markingProblems(net, markingOfIndexed(indexed))).toStrictEqual([]);
}

function advance(net: Net, marking: Marking, indexed: Indexed, operation: Operation): readonly [Marking, Indexed] {
	if (operation.kind === "step") {
		const expected = fireStep(net, marking, operation.policy);
		const actual = stepIndexed(indexed, operation.policy);
		exact(actual.fired, expected.fired);
		return [expected.marking, actual.indexed];
	}
	let next = marking;
	let owner = indexed;
	for (const [place, tokens] of Object.entries(operation.marking)) {
		next = addTokens(next, placeId(place), tokens);
		owner = addTokensIndexed(owner, placeId(place), tokens);
	}
	return [next, owner];
}

function sequence(net: Net, initial: Marking, operations: readonly Operation[], rebuildAt: number): void {
	let marking = initial;
	let indexed = indexMarking(net, marking);
	let rebuilt: Indexed | undefined;
	sameState(net, marking, indexed);
	operations.forEach((operation, index) => {
		if (index === rebuildAt) rebuilt = indexMarking(net, markingOfIndexed(indexed));
		const [expected, next] = advance(net, marking, indexed, operation);
		if (rebuilt !== undefined) {
			const [, nextRebuilt] = advance(net, marking, rebuilt, operation);
			rebuilt = nextRebuilt;
			sameState(net, expected, rebuilt);
		}
		marking = expected;
		indexed = next;
		sameState(net, marking, indexed);
	});
}

// Each property checks up to 600 operations. Concurrent Istanbul instrumentation exceeded Vitest's default 5 seconds.
test("P1: steps and additions preserve the oracle's enabled list, fired elements and exact marking", {
	timeout: 15_000,
}, () => {
	fc.assert(
		fc.property(netArbitrary, markingArbitrary, operationsArbitrary, (net, marking, operations) => {
			sequence(net, marking, operations, -1);
		}),
		{ numRuns: 20 },
	);
});

test("P2: indexing and materializing preserve token representation and place key order", () => {
	fc.assert(
		fc.property(netArbitrary, markingArbitrary, (net, marking) => {
			const reordered = Object.fromEntries(Object.entries(marking).reverse());
			exact(markingOfIndexed(indexMarking(net, reordered)), reordered);
		}),
	);
});

test("P3: rebuilding at any point preserves the rest of the sequence", { timeout: 15_000 }, () => {
	fc.assert(
		fc.property(netArbitrary, markingArbitrary, operationsArbitrary, fc.nat(), (net, marking, operations, at) => {
			sequence(net, marking, operations, at % operations.length);
		}),
		{ numRuns: 20 },
	);
});

test("duplicate and postponing policies preserve the oracle through place removal and reintroduction", () => {
	const colourSet = { name: "any", contains: () => true };
	const left = { id: placeId("__proto__"), colourSet };
	const right = { id: placeId("constructor"), colourSet };
	const expression = { id: placeId("expression"), colourSet };
	const net: Net = {
		places: [left, right, expression],
		transitions: [
			{
				id: transitionId("join"),
				variables: { x: colourSet, y: colourSet },
				guard: () => true,
				inputs: [
					{ place: left, variables: ["x", "y"] },
					{ place: right, variables: ["x"] },
					{ place: expression, expression: (binding) => [binding.x ?? null] },
				],
				outputs: [],
			},
		],
	};
	const pair = [
		{ b: 1, a: 0 },
		{ a: 0, b: 1 },
	];
	const marking = { [right.id]: pair, [left.id]: [...pair, ...pair], [expression.id]: pair };
	const duplicate: SelectionPolicy = (enabled) => [...enabled, ...enabled];
	const postpone: SelectionPolicy = () => [];
	expect(fireStep(net, marking, duplicate).fired).toHaveLength(2);
	expect(fireStep(net, marking, duplicate).marking).toStrictEqual({});
	sequence(
		net,
		marking,
		[
			{ kind: "step", policy: postpone },
			{ kind: "step", policy: duplicate },
			{ kind: "add", marking },
			{ kind: "step", policy: duplicate },
		],
		2,
	);
});

// P4 belongs with joinKeys: compare annotated nets with the same nets without annotations.
