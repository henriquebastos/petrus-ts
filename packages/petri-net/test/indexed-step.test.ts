import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { expect } from "vitest";
import { combinations, transitionIndex, updateDomain } from "../src/candidate-binding.ts";
import type { IndexedMarking } from "../src/indexed-marking.ts";
import { readIndex } from "../src/indexed-marking.ts";
import { emptyPlaceIndex, removeIndexed } from "../src/place-index.ts";
import type {
	ColourSet,
	Marking,
	MarkingJournalOp,
	Net,
	Place,
	SelectionPolicy,
	Token,
	Transition,
} from "../src/index.ts";
import {
	addTokens,
	addTokensIndexed,
	clearJournalIndexed,
	definitionOrder,
	enabledElements,
	enabledElementsIndexed,
	fireStep,
	indexMarking,
	markingOfIndexed,
	placeId,
	stepIndexed,
	tokenKey,
	transitionId,
} from "../src/index.ts";
import { keyCountingTokens } from "./arbitraries.ts";

const any: ColourSet = { name: "JSON", contains: () => true };
const a: Place = { id: placeId("a"), colourSet: any };
const b: Place = { id: placeId("b"), colourSet: any };
const c: Place = { id: placeId("__proto__"), colourSet: any };
const transfer: Transition<"x"> = {
	id: transitionId("transfer"),
	variables: { x: any },
	guard: () => true,
	inputs: [{ place: a, variables: ["x"] }],
	outputs: [{ place: b, expression: ({ x }) => [x] }],
};
const net: Net = { places: [a, b, c], transitions: [transfer] };

function replay(start: Marking, journal: readonly MarkingJournalOp[]): Marking {
	const places = new Map(Object.entries(start).map(([place, tokens]) => [place, [...tokens]]));
	for (const op of journal) {
		applyOperation(places, op);
	}
	return Object.fromEntries(places);
}

function applyOperation(places: Map<string, Token[]>, op: MarkingJournalOp): void {
	const tokens = places.get(op.place) ?? [];
	switch (op.kind) {
		case "append":
			places.set(op.place, [...tokens, ...op.tokens]);
			break;
		case "remove":
			tokens.splice(op.index, 1);
			break;
		case "drop":
			places.delete(op.place);
			break;
	}
}

test.prop([fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 30 })])(
	"journal replay preserves token order and place order through removal, drop and refill",
	(tokens) => {
		const start: Marking = { [a.id]: tokens, [c.id]: [null], [b.id]: ["old"] };
		const initial = indexMarking(net, start);
		expect(initial.journal).toStrictEqual([]);
		const stepped = stepIndexed(initial, (enabled) => [...enabled, ...enabled]);
		const current = addTokensIndexed(stepped.indexed, a.id, ["refill"]);
		const marking = markingOfIndexed(current);
		const replayed = replay(start, current.journal);
		expect(replayed).toStrictEqual(marking);
		expect(Object.keys(replayed)).toStrictEqual(Object.keys(marking));
		const saved = [...current.journal];
		const cleared = clearJournalIndexed(current);
		expect(cleared.journal).toStrictEqual([]);
		expect(markingOfIndexed(cleared)).toStrictEqual(marking);
		expect(saved.length).toBeGreaterThan(0);
		expect(() => current.journal).toThrow(/spent/);
	},
);

test("consumed owners reject every read and mutation, including after an empty addition", () => {
	const initial = indexMarking(net, { [a.id]: [1] });
	const next = addTokensIndexed(initial, a.id, []);
	expect(markingOfIndexed(next)).toStrictEqual({ [a.id]: [1] });
	expect(() => markingOfIndexed(initial)).toThrow(/spent/);
	expect(() => enabledElementsIndexed(initial)).toThrow(/spent/);
	expect(() => initial.journal).toThrow(/spent/);
	expect(() => stepIndexed(initial, definitionOrder)).toThrow(/spent/);
	expect(() => addTokensIndexed(initial, a.id, [2])).toThrow(/spent/);
	expect(() => clearJournalIndexed(initial)).toThrow(/spent/);
});

test("policy and output failures leave the old owner spent", () => {
	const initial = indexMarking(net, { [a.id]: [1] });
	expect(() =>
		stepIndexed(initial, () => {
			throw new Error("policy failed");
		}),
	).toThrow("policy failed");
	expect(() => markingOfIndexed(initial)).toThrow(/spent/);
	const broken: Transition = {
		...transfer,
		outputs: [
			{
				place: b,
				expression: () => {
					throw new Error("output failed");
				},
			},
		],
	};
	const owner = indexMarking({ ...net, transitions: [broken] }, { [a.id]: [1] });
	expect(() => stepIndexed(owner, definitionOrder)).toThrow("output failed");
	expect(() => markingOfIndexed(owner)).toThrow(/spent/);
});

test("candidate failures during an addition leave the old owner spent", () => {
	const broken: Transition = {
		...transfer,
		guard: () => {
			throw new Error("guard failed");
		},
	};
	const owner = indexMarking({ ...net, transitions: [broken] }, {});
	expect(() => addTokensIndexed(owner, a.id, [1])).toThrow("guard failed");
	expect(() => markingOfIndexed(owner)).toThrow(/spent/);
});

test("changed fronts rebuild bindings with the first surviving token object", () => {
	const first = { a: 1, b: 2 };
	const second = { b: 2, a: 1 };
	const initial = indexMarking(net, { [a.id]: [first, 7, second] });
	const stepped = stepIndexed(initial, (enabled) => enabled.slice(0, 1));
	expect(enabledElementsIndexed(stepped.indexed).map(({ binding }) => binding.x)).toStrictEqual([7, second]);
	expect(enabledElementsIndexed(stepped.indexed)[1]?.binding.x).toBe(second);
	expect(Object.keys(enabledElementsIndexed(stepped.indexed)[1]?.binding.x ?? {})).toStrictEqual(["b", "a"]);
});

test("expression demand watchers enable cached candidates without rerunning guards or expressions", () => {
	let guards = 0;
	let expressions = 0;
	const waiting: Transition<"x"> = {
		...transfer,
		guard: () => {
			guards++;
			return true;
		},
		inputs: [
			{ place: a, variables: ["x"] },
			{
				place: c,
				expression: ({ x }) => {
					expressions++;
					return [x, x];
				},
			},
		],
	};
	const indexed = indexMarking({ ...net, transitions: [waiting] }, { [a.id]: [1, 2] });
	expect(enabledElementsIndexed(indexed)).toStrictEqual([]);
	const one = addTokensIndexed(indexed, c.id, [2]);
	expect(enabledElementsIndexed(one)).toStrictEqual([]);
	const two = addTokensIndexed(one, c.id, [2]);
	expect(enabledElementsIndexed(two)).toStrictEqual([{ transition: transfer.id, binding: { x: 2 } }]);
	expect(stepIndexed(two, definitionOrder).fired).toHaveLength(1);
	expect({ guards, expressions }).toStrictEqual({ guards: 2, expressions: 2 });
});

test("invented and duplicate policy elements use remaining counts and validate their own transition", () => {
	const start: Marking = { [a.id]: [1, 1, 2] };
	const other: Transition = { ...transfer, id: transitionId("other"), guard: () => false };
	const testNet = { ...net, transitions: [transfer, other] };
	const policy: SelectionPolicy = (enabled) => [
		...enabled.map((element) => ({ ...element, transition: other.id })),
		{ transition: transfer.id, binding: { ghost: 1 } },
		{ transition: transfer.id, binding: { x: 9 } },
		{ transition: transfer.id, binding: { x: 1 } },
		...enabled,
		...enabled,
	];
	const expected = fireStep(testNet, start, policy);
	const actual = stepIndexed(indexMarking(testNet, start), policy);
	expect(actual.fired).toStrictEqual(expected.fired);
	expect(markingOfIndexed(actual.indexed)).toStrictEqual(expected.marking);
	const owner = indexMarking(net, start);
	expect(() => stepIndexed(owner, () => [{ transition: transitionId("missing"), binding: {} }])).toThrow(
		/not a transition/,
	);
	expect(() => markingOfIndexed(owner)).toThrow(/spent/);
});

const joined: Transition<"x" | "y"> = {
	id: transitionId("join"),
	variables: { x: any, y: any },
	guard: ({ x, y }) => tokenKey(x) === tokenKey(y),
	inputs: [
		{ place: a, variables: ["x"] },
		{ place: b, variables: ["y"] },
	],
	outputs: [{ place: c, expression: ({ x, y }) => [x, y] }],
};
const joinNet: Net = { ...net, transitions: [joined] };
const keyedNet: Net = { ...net, transitions: [{ ...joined, joinKeys: { x: tokenKey, y: tokenKey } }] };
const numbers = fc.array(fc.integer({ min: 0, max: 8 }), { maxLength: 15 });

test.prop([numbers, numbers, numbers])(
	"P4: valid join keys preserve the unjoined oracle across additions and steps",
	(left, right, extra) => {
		let marking: Marking = {};
		let indexed = indexMarking(keyedNet, marking);
		for (const [place, tokens] of [
			[a.id, left],
			[b.id, right],
			[a.id, extra],
		] as const) {
			marking = { ...marking, ...(tokens.length === 0 ? {} : { [place]: [...(marking[place] ?? []), ...tokens] }) };
			indexed = addTokensIndexed(indexed, place, tokens);
			expect(enabledElementsIndexed(indexed)).toStrictEqual(enabledElements(joinNet, marking));
			const expected = fireStep(joinNet, marking, (enabled) => [...enabled].reverse());
			const actual = stepIndexed(indexed, (enabled) => [...enabled].reverse());
			expect(actual.fired).toStrictEqual(expected.fired);
			expect(markingOfIndexed(actual.indexed)).toStrictEqual(expected.marking);
			marking = expected.marking;
			indexed = actual.indexed;
		}
	},
);

test("P4 detects a broken join declaration by finding a counterexample", () => {
	const broken: Net = { ...net, transitions: [{ ...joined, joinKeys: { x: () => "left", y: () => "right" } }] };
	const result = fc.check(
		fc.property(fc.integer(), (value) => {
			const start = { [a.id]: [value], [b.id]: [value] };
			return enabledElementsIndexed(indexMarking(broken, start)).length === enabledElements(joinNet, start).length;
		}),
	);
	expect(result.failed).toBe(true);
	expect(result.counterexample).not.toBeNull();
});

test.each([10, 1000])("one joined arrival keys and checks only its matching candidate at size %i", (size) => {
	const { tokens, reads } = keyCountingTokens(size);
	let guards = 0;
	const transition: Transition = {
		...joined,
		guard: (binding) => {
			guards++;
			return joined.guard({ x: binding.x ?? null, y: binding.y ?? null });
		},
		joinKeys: { x: tokenKey, y: tokenKey },
	};
	const indexed = indexMarking({ ...net, transitions: [transition] }, { [a.id]: tokens });
	const before = reads();
	const added = addTokensIndexed(indexed, b.id, [{ id: 0 }]);
	expect(guards).toBe(1);
	expect(reads() - before).toBe(2);
	const stepped = stepIndexed(added, definitionOrder);
	expect(stepped.fired).toHaveLength(1);
	expect(guards).toBe(1);
	expect(reads() - before).toBe(3);
});

function firstKey(token: Token): string {
	return typeof token === "object" && token !== null ? (Object.keys(token)[0] ?? "") : "";
}

test.each(["a", "b"])("front changes reevaluate a representation-sensitive guard accepting %s", (accepted) => {
	const remover: Transition = { ...transfer, id: transitionId("remove"), outputs: [] };
	const inspected: Transition<"x"> = { ...transfer, guard: ({ x }) => firstKey(x) === accepted, outputs: [] };
	const testNet: Net = { ...net, transitions: [remover, inspected] };
	const start: Marking = {
		[a.id]: [
			{ a: 1, b: 2 },
			{ b: 2, a: 1 },
		],
	};
	const indexed = indexMarking(testNet, start);
	const policy: SelectionPolicy = (enabled) =>
		enabled.filter((element) => element.transition === remover.id).slice(0, 1);
	const actual = stepIndexed(indexed, policy);
	const expected = fireStep(testNet, start, policy);
	expect(enabledElementsIndexed(actual.indexed)).toStrictEqual(enabledElements(testNet, expected.marking));
	expect(enabledElementsIndexed(actual.indexed).some((element) => element.transition === inspected.id)).toBe(
		accepted === "b",
	);
});

test("front changes replace expression demand and its watchers", () => {
	const remover: Transition = { ...transfer, id: transitionId("remove"), outputs: [] };
	const inspected: Transition<"x"> = {
		...transfer,
		inputs: [
			{ place: a, variables: ["x"] },
			{ place: b, expression: ({ x }) => [firstKey(x)] },
		],
		outputs: [],
	};
	const testNet: Net = { ...net, transitions: [remover, inspected] };
	const start: Marking = {
		[a.id]: [
			{ a: 1, b: 2 },
			{ b: 2, a: 1 },
		],
		[b.id]: ["a"],
	};
	const policy: SelectionPolicy = (enabled) =>
		enabled.filter((element) => element.transition === remover.id).slice(0, 1);
	const actual = stepIndexed(indexMarking(testNet, start), policy);
	const expected = fireStep(testNet, start, policy);
	expect(enabledElementsIndexed(actual.indexed)).toStrictEqual(enabledElements(testNet, expected.marking));
	const ready = addTokensIndexed(actual.indexed, b.id, ["b"]);
	expect(enabledElementsIndexed(ready).some((element) => element.transition === inspected.id)).toBe(true);
	const result = stepIndexed(ready, (enabled) => enabled.filter((element) => element.transition === inspected.id));
	expect(markingOfIndexed(result.indexed)).toStrictEqual({ [b.id]: ["a"] });
});

test("front changes move join buckets and create newly matching combinations", () => {
	let guards = 0;
	const remover: Transition = { ...transfer, id: transitionId("remove"), outputs: [] };
	const inspected: Transition<"x" | "y"> = {
		...joined,
		guard: ({ x, y }) => {
			guards++;
			return firstKey(x) === firstKey(y);
		},
		joinKeys: { x: firstKey, y: firstKey },
	};
	const testNet: Net = { ...net, transitions: [remover, inspected] };
	const start: Marking = {
		[a.id]: [
			{ a: 1, b: 2 },
			{ b: 2, a: 1 },
		],
		[b.id]: [
			{ a: 3, b: 4 },
			{ b: 5, a: 6 },
		],
	};
	const policy: SelectionPolicy = (enabled) =>
		enabled.filter((element) => element.transition === remover.id).slice(0, 1);
	const initial = indexMarking(testNet, start);
	guards = 0;
	const actual = stepIndexed(initial, policy);
	expect(guards).toBe(1);
	const expected = fireStep(testNet, start, policy);
	expect(enabledElementsIndexed(actual.indexed)).toStrictEqual(enabledElements(testNet, expected.marking));
	expect(enabledElementsIndexed(actual.indexed).filter((element) => element.transition === inspected.id)).toHaveLength(
		1,
	);
});

test.prop([numbers, numbers, numbers, fc.constantFrom("x", "y", "z")])(
	"partial many-to-one joins preserve the oracle when an unjoined variable arrives",
	(left, middle, right, unjoined) => {
		let guards = 0;
		const parity = (token: Token): string => (typeof token === "number" && token % 2 === 0 ? "" : "odd");
		const joinKeys = Object.fromEntries(
			["x", "y", "z"].filter((name) => name !== unjoined).map((name) => [name, parity]),
		);
		const transition: Transition = {
			id: transitionId("partial"),
			variables: { x: any, y: any, z: any },
			guard: (binding) => {
				guards++;
				return new Set(Object.keys(joinKeys).map((name) => parity(binding[name] ?? null))).size === 1;
			},
			joinKeys,
			inputs: [
				{ place: a, variables: ["x"] },
				{ place: b, variables: ["y"] },
				{ place: c, variables: ["z"] },
			],
			outputs: [],
		};
		const testNet: Net = { ...net, transitions: [transition] };
		const start: Marking = Object.fromEntries(
			Object.entries({ [a.id]: left, [b.id]: middle, [c.id]: right }).filter(([, tokens]) => tokens.length > 0),
		);
		let indexed = indexMarking(testNet, start);
		const before = enabledElementsIndexed(indexed).length;
		expect(guards).toBe(before);
		expect(enabledElementsIndexed(indexed)).toStrictEqual(enabledElements(testNet, start));
		const place = { x: a, y: b, z: c }[unjoined];
		guards = 0;
		indexed = addTokensIndexed(indexed, place.id, [8]);
		expect(guards).toBe(enabledElementsIndexed(indexed).length - before);
		let marking = addTokens(start, place.id, [8]);
		expect(enabledElementsIndexed(indexed)).toStrictEqual(enabledElements(testNet, marking));
		for (const joinedPlace of [a, b, c].filter((each) => each !== place)) {
			indexed = addTokensIndexed(indexed, joinedPlace.id, [10]);
			marking = addTokens(marking, joinedPlace.id, [10]);
			expect(enabledElementsIndexed(indexed)).toStrictEqual(enabledElements(testNet, marking));
		}
		const policy: SelectionPolicy = (enabled) => enabled.slice(0, 1);
		const actual = stepIndexed(indexed, policy);
		const expected = fireStep(testNet, marking, policy);
		expect(actual.fired).toStrictEqual(expected.fired);
		expect(markingOfIndexed(actual.indexed)).toStrictEqual(expected.marking);
	},
);

test("a join bucket retains other values when one value leaves", () => {
	let guards = 0;
	const parity = (token: Token): string => String(Number(token) % 2);
	const transition: Transition = {
		...joined,
		guard: ({ x, y }) => {
			guards++;
			return parity(x ?? null) === parity(y ?? null);
		},
		joinKeys: { x: parity, y: parity },
	};
	const testNet: Net = { ...net, transitions: [transition] };
	const initial = indexMarking(testNet, { [a.id]: [0, 2, 1], [b.id]: [4] });
	expect(guards).toBe(2);
	const stepped = stepIndexed(initial, (enabled) => enabled.slice(0, 1));
	guards = 0;
	const added = addTokensIndexed(stepped.indexed, b.id, [6]);
	expect(enabledElementsIndexed(added)).toStrictEqual([{ transition: joined.id, binding: { x: 2, y: 6 } }]);
	expect(guards).toBe(1);
});

test("new combinations exclude values that left an unjoined domain", () => {
	let guards = 0;
	const transition: Transition = {
		...joined,
		guard: () => {
			guards++;
			return true;
		},
	};
	const testNet: Net = { ...net, transitions: [transition] };
	const initial = indexMarking(testNet, { [a.id]: [1, 2], [b.id]: [3] });
	const stepped = stepIndexed(initial, (enabled) => enabled.slice(0, 1));
	guards = 0;
	const added = addTokensIndexed(stepped.indexed, b.id, [4]);
	expect(enabledElementsIndexed(added)).toStrictEqual([{ transition: joined.id, binding: { x: 2, y: 4 } }]);
	expect(guards).toBe(1);
});

test("a fixed arrival enumerates only its combinations, before guard evaluation", () => {
	const owner = transitionIndex(joined);
	for (const domain of owner.domains) {
		updateDomain(domain, "one", [0, 1]);
		updateDomain(domain, "two", [1, 2]);
	}
	for (const domain of owner.domains) {
		const expected =
			domain.variable === "x"
				? [
						["two", "one"],
						["two", "two"],
					]
				: [
						["one", "two"],
						["two", "two"],
					];
		expect(combinations(owner, { domain, key: "two" })).toStrictEqual(expected);
	}
});

test("missing variable inputs and missing indexed tokens report the offending name", () => {
	const broken: Transition = { ...transfer, inputs: [] };
	expect(() => indexMarking({ ...net, transitions: [broken] }, {})).toThrow(
		"transfer: variable x is on no variable input arc",
	);
	expect(() => removeIndexed(emptyPlaceIndex(), "missing")).toThrow("the indexed place holds no token missing");
});

test("draining and refilling a net retains no obsolete token or candidate entries", () => {
	const transition: Transition<"x" | "y"> = {
		...joined,
		guard: ({ x, y }) => firstKey(x) === firstKey(y),
		joinKeys: { x: firstKey, y: firstKey },
		outputs: [],
	};
	const rejected: Transition = { ...transfer, guard: () => false };
	const testNet: Net = { ...net, transitions: [transition, rejected] };
	let indexed = indexMarking(testNet, {});
	for (let cycle = 0; cycle < 10; cycle++) {
		const tokens = [
			{ a: cycle % 2, b: cycle % 2 },
			{ b: cycle % 2, a: cycle % 2 },
		];
		indexed = addTokensIndexed(indexed, a.id, tokens);
		indexed = addTokensIndexed(indexed, b.id, tokens);
		const first = stepIndexed(indexed, definitionOrder);
		expect(first.fired.map(({ binding }) => Object.keys(binding.x ?? {}))).toStrictEqual([["a", "b"]]);
		const second = stepIndexed(first.indexed, definitionOrder);
		expect(second.fired.map(({ binding }) => Object.keys(binding.x ?? {}))).toStrictEqual([["b", "a"]]);
		indexed = clearJournalIndexed(second.indexed);
		expect(markingOfIndexed(indexed)).toStrictEqual({});
		expect([...first.fired, ...second.fired].some(({ binding }) => readIndex(indexed).bindings.has(binding))).toBe(
			false,
		);
		expectDrained(indexed);
	}
	indexed = addTokensIndexed(indexed, a.id, [null]);
	indexed = addTokensIndexed(indexed, b.id, [null]);
	indexed = stepIndexed(indexed, definitionOrder).indexed;
	expectDrained(indexed);
});

test("a policy can reuse a retired binding after equal tokens return with a different representation", () => {
	const inspected: Transition<"x"> = { ...transfer, guard: ({ x }) => firstKey(x) === "a" };
	const testNet: Net = { ...net, transitions: [inspected] };
	const first = stepIndexed(indexMarking(testNet, { [a.id]: [{ a: 1, b: 2 }] }), definitionOrder);
	const refilled = addTokensIndexed(first.indexed, a.id, [{ b: 2, a: 1 }]);
	expect(enabledElementsIndexed(refilled)).toStrictEqual([]);
	const marking = markingOfIndexed(refilled);
	const policy: SelectionPolicy = () => first.fired;
	const actual = stepIndexed(refilled, policy);
	const expected = fireStep(testNet, marking, policy);
	expect(actual.fired).toStrictEqual(first.fired);
	expect(JSON.stringify(markingOfIndexed(actual.indexed))).toBe(JSON.stringify(expected.marking));
});

// Retention is part of the index contract. Ignore arrival counters and fixed, per-net containers.
function expectDrained(indexed: IndexedMarking): void {
	const state = readIndex(indexed);
	for (const owner of state.transitions) {
		expect([...owner.candidates.values(), ...owner.enabled]).toStrictEqual([]);
		for (const domain of owner.domains) {
			expect([...domain.values.keys(), ...domain.joins.keys(), ...domain.buckets.keys()]).toStrictEqual([]);
		}
	}
	for (const watchers of state.watchers.values()) {
		expect([...watchers.keys()]).toStrictEqual([]);
	}
	for (const place of state.places.values()) {
		expect([...place.copies.keys(), ...place.tokens.keys(), ...place.stored]).toStrictEqual([]);
	}
}
