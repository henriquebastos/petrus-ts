import { fc, test } from "@fast-check/vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, vi } from "vitest";
import type { ColourSet, InputArc, Place, Transition } from "../src/index.ts";
import { enabledBindings, fire, placeId, transitionId } from "../src/index.ts";
import { canonical, countTokens, firingArbitrary } from "./arbitraries.ts";

const commentSchema = Type.Object({ author: Type.String(), pr: Type.String() });
const comment: ColourSet = { name: "Comment", contains: (token) => Value.Check(commentSchema, token) };
const pr: ColourSet = { name: "Pr", contains: (token) => Value.Check(Type.String(), token) };

const comments: Place = { id: placeId("comments"), colourSet: comment };
const resource: Place = { id: placeId("resource"), colourSet: pr };
const replies: Place = { id: placeId("replies"), colourSet: comment };

/** Answers a comment while it holds the resource token of the comment's pull request, then gives the token back. */
const answer: Transition<"c" | "r"> = {
	id: transitionId("answer"),
	variables: { c: comment, r: pr },
	guard: ({ c, r }) => Value.Check(commentSchema, c) && c.pr === r,
	inputs: [
		{ place: comments, variables: ["c"] },
		{ place: resource, variables: ["r"] },
	],
	outputs: [
		{ place: replies, expression: ({ c }) => [c] },
		{ place: resource, expression: ({ r }) => [r] },
	],
};

/** Answers a comment while it holds the resource token of the comment's pull request, which an arc computes. */
const answerOwnPr: Transition<"c"> = {
	id: transitionId("answer"),
	variables: { c: comment },
	guard: () => true,
	inputs: [
		{ place: comments, variables: ["c"] },
		{ place: resource, expression: ({ c }) => (Value.Check(commentSchema, c) ? [c.pr] : []) },
	],
	outputs: [{ place: replies, expression: ({ c }) => [c] }],
};

const ana = { author: "ana", pr: "pr-1" };
const bob = { author: "bob", pr: "pr-2" };

describe("fire, examples", () => {
	test("takes the input tokens of the binding and gives the output tokens", () => {
		const marking = { [comments.id]: [ana, bob], [resource.id]: ["pr-2", "pr-1"] };
		expect(fire(answer, { c: ana, r: "pr-1" }, marking)).toStrictEqual({
			ok: true,
			value: { [comments.id]: [bob], [resource.id]: ["pr-2", "pr-1"], [replies.id]: [ana] },
		});
	});

	test("removes a place that has no tokens left", () => {
		const fired = fire(answer, { c: ana, r: "pr-1" }, { [comments.id]: [ana], [resource.id]: ["pr-1"] });
		expect(fired).toStrictEqual({ ok: true, value: { [resource.id]: ["pr-1"], [replies.id]: [ana] } });
	});

	test("treats tokens with equal JSON values as equal, whatever the key order", () => {
		const marking = { [comments.id]: [{ pr: "pr-1", author: "ana" }], [resource.id]: ["pr-1"] };
		expect(fire(answer, { c: ana, r: "pr-1" }, marking).ok).toBe(true);
	});

	test("reports a false guard as not-a-binding", () => {
		expect(fire(answer, { c: ana, r: "pr-2" }, { [comments.id]: [ana], [resource.id]: ["pr-2"] })).toStrictEqual({
			ok: false,
			error: { kind: "not-a-binding", transition: answer.id, problems: ["answer: the guard is false"] },
		});
	});

	test("reports each wrong value as not-a-binding and does not run the guard", () => {
		const guard = vi.fn(() => true);
		const fired = fire({ ...answer, guard }, { c: 7, x: null }, {});
		expect(fired).toStrictEqual({
			ok: false,
			error: {
				kind: "not-a-binding",
				transition: answer.id,
				problems: [
					"answer: variable r has no value",
					"answer: c = 7 is not in Comment",
					"answer: x is not a variable",
				],
			},
		});
		expect(guard).not.toHaveBeenCalled();
	});

	test("reports the tokens that each input place lacks as not-enabled", () => {
		expect(fire(answer, { c: ana, r: "pr-1" }, { [resource.id]: ["pr-2"] })).toStrictEqual({
			ok: false,
			error: {
				kind: "not-enabled",
				transition: answer.id,
				shortfalls: [
					{ place: comments.id, missing: [ana] },
					{ place: resource.id, missing: ["pr-1"] },
				],
			},
		});
	});

	test("takes one token for each entry, so a variable listed twice takes two equal tokens", () => {
		const pair: Transition<"r"> = {
			id: transitionId("pair"),
			variables: { r: pr },
			guard: () => true,
			inputs: [
				{ place: resource, variables: ["r", "r"] },
				{ place: resource, variables: ["r"] },
			],
			outputs: [],
		};
		expect(fire(pair, { r: "pr-1" }, { [resource.id]: ["pr-1", "pr-1"] })).toStrictEqual({
			ok: false,
			error: { kind: "not-enabled", transition: pair.id, shortfalls: [{ place: resource.id, missing: ["pr-1"] }] },
		});
		expect(fire(pair, { r: "pr-1" }, { [resource.id]: ["pr-1", "pr-2", "pr-1", "pr-1"] })).toStrictEqual({
			ok: true,
			value: { [resource.id]: ["pr-2"] },
		});
	});

	test("throws a TypeError for an output token outside its place's colour set, a bug in the net", () => {
		const broken: Transition<"c" | "r"> = {
			...answer,
			outputs: [{ place: replies, expression: ({ r }) => [r, 7] }],
		};
		expect(() => fire(broken, { c: ana, r: "pr-1" }, { [comments.id]: [ana], [resource.id]: ["pr-1"] })).toThrow(
			new TypeError('answer: output "pr-1", 7 on replies is not in Comment'),
		);
	});
});

describe("expression input arcs, examples", () => {
	test("takes the tokens that an expression input arc computes, and is enabled only when they are there", () => {
		const marking = { [comments.id]: [ana, bob], [resource.id]: ["pr-1"] };
		expect(enabledBindings(answerOwnPr, marking)).toStrictEqual([{ c: ana }]);
		expect(fire(answerOwnPr, { c: ana }, marking)).toStrictEqual({
			ok: true,
			value: { [comments.id]: [bob], [replies.id]: [ana] },
		});
		expect(fire(answerOwnPr, { c: bob }, marking)).toStrictEqual({
			ok: false,
			error: {
				kind: "not-enabled",
				transition: answerOwnPr.id,
				shortfalls: [{ place: resource.id, missing: ["pr-2"] }],
			},
		});
	});

	test("adds the tokens of an expression input arc to the tokens of a variable arc from the same place", () => {
		const twice: Transition<"r"> = {
			id: transitionId("twice"),
			variables: { r: pr },
			guard: () => true,
			inputs: [
				{ place: resource, expression: ({ r }) => [r] },
				{ place: resource, variables: ["r"] },
			],
			outputs: [],
		};
		expect(enabledBindings(twice, { [resource.id]: ["pr-1", "pr-2"] })).toStrictEqual([]);
		expect(fire(twice, { r: "pr-1" }, { [resource.id]: ["pr-1", "pr-2"] })).toStrictEqual({
			ok: false,
			error: { kind: "not-enabled", transition: twice.id, shortfalls: [{ place: resource.id, missing: ["pr-1"] }] },
		});
		const marking = { [resource.id]: ["pr-1", "pr-2", "pr-1"] };
		expect(enabledBindings(twice, marking)).toStrictEqual([{ r: "pr-1" }]);
		expect(fire(twice, { r: "pr-1" }, marking)).toStrictEqual({ ok: true, value: { [resource.id]: ["pr-2"] } });
	});

	test("an input arc lists variables or computes its tokens, and not both", () => {
		const variables: readonly "r"[] = ["r"];
		const both = { place: resource, variables, expression: () => [] };
		// @ts-expect-error -- an arc with a list of variables has no expression, so the expression is not ignored.
		const arc: InputArc<"r"> = both;
		expect(arc.variables).toStrictEqual(["r"]);
	});

	test("takes a variable's values only from variable input arcs, in their order", () => {
		const other: Place = { id: placeId("other"), colourSet: pr };
		const expression = vi.fn(() => []);
		const after: Transition<"r"> = {
			id: transitionId("after"),
			variables: { r: pr },
			guard: () => true,
			inputs: [
				{ place: other, expression },
				{ place: resource, variables: ["r"] },
			],
			outputs: [],
		};
		const marking = { [other.id]: ["pr-3", "pr-2"], [resource.id]: ["pr-1", "pr-2"] };
		expect(enabledBindings(after, marking)).toStrictEqual([{ r: "pr-1" }, { r: "pr-2" }]);
		expect(expression.mock.calls).toStrictEqual([[{ r: "pr-1" }], [{ r: "pr-2" }]]);
	});

	test("runs an expression input arc only for right values and a true guard", () => {
		const expression = vi.fn(() => ["pr-1"]);
		const guarded: Transition<"c"> = {
			...answerOwnPr,
			guard: ({ c }) => c !== null,
			inputs: [
				{ place: comments, variables: ["c"] },
				{ place: resource, expression },
			],
		};
		expect(fire(guarded, { c: 7 }, {}).ok).toBe(false);
		expect(fire(guarded, {}, {}).ok).toBe(false);
		expect(fire({ ...guarded, guard: () => false }, { c: ana }, { [comments.id]: [ana] }).ok).toBe(false);
		expect(enabledBindings({ ...guarded, guard: () => false }, { [comments.id]: [ana] })).toStrictEqual([]);
		expect(expression).not.toHaveBeenCalled();
		expect(enabledBindings(guarded, { [comments.id]: [ana, bob, ana], [resource.id]: ["pr-1"] })).toStrictEqual([
			{ c: ana },
			{ c: bob },
		]);
		expect(expression).toHaveBeenCalledTimes(2);
	});

	test("throws a TypeError for an input token outside its place's colour set, a bug in the net", () => {
		const broken: Transition<"c"> = {
			...answerOwnPr,
			inputs: [
				{ place: comments, variables: ["c"] },
				{ place: resource, expression: () => [7, "pr-1", null] },
			],
		};
		const marking = { [comments.id]: [ana], [resource.id]: ["pr-1"] };
		const error = new TypeError("answer: input 7, null on resource is not in Pr");
		expect(() => fire(broken, { c: ana }, marking)).toThrow(error);
		expect(() => enabledBindings(broken, marking)).toThrow(error);
	});
});

describe("enabledBindings, examples", () => {
	test("lists each enabled binding once: variables in declaration order, values in arrival order", () => {
		const marking = { [comments.id]: [bob, ana, bob], [resource.id]: ["pr-1", "pr-2"] };
		expect(enabledBindings(answer, marking)).toStrictEqual([
			{ c: bob, r: "pr-2" },
			{ c: ana, r: "pr-1" },
		]);
	});

	test("takes a variable's values only from the places of its own arcs", () => {
		const other: Place = { id: placeId("other"), colourSet: pr };
		const both: Transition<"r" | "s"> = {
			id: transitionId("both"),
			variables: { r: pr, s: pr },
			guard: () => true,
			inputs: [
				{ place: resource, variables: ["r"] },
				{ place: other, variables: ["s"] },
			],
			outputs: [],
		};
		expect(enabledBindings(both, { [resource.id]: ["pr-1"], [other.id]: ["pr-2", "pr-1"] })).toStrictEqual([
			{ r: "pr-1", s: "pr-2" },
			{ r: "pr-1", s: "pr-1" },
		]);
	});

	test("a variable on two input arcs needs an equal token on both places", () => {
		const ci: Place = { id: placeId("ci"), colourSet: pr };
		const join: Transition<"r"> = {
			id: transitionId("join"),
			variables: { r: pr },
			guard: () => true,
			inputs: [
				{ place: resource, variables: ["r"] },
				{ place: ci, variables: ["r"] },
			],
			outputs: [],
		};
		expect(enabledBindings(join, { [resource.id]: ["pr-1", "pr-2"], [ci.id]: ["pr-2", "pr-3"] })).toStrictEqual([
			{ r: "pr-2" },
		]);
	});

	test("a transition with no variables has one binding, the empty one", () => {
		const start: Transition<never> = {
			id: transitionId("start"),
			variables: {},
			guard: () => true,
			inputs: [],
			outputs: [{ place: resource, expression: () => ["pr-9"] }],
		};
		expect(enabledBindings(start, {})).toStrictEqual([{}]);
		expect(enabledBindings({ ...start, guard: () => false }, {})).toStrictEqual([]);
	});
});

describe("fire, properties", () => {
	test.prop([firingArbitrary])(
		"fires exactly the bindings that enabledBindings lists",
		({ transition, binding, marking }) => {
			const listed = enabledBindings(transition, marking).map(canonical);
			expect(fire(transition, binding, marking).ok).toBe(listed.includes(canonical(binding)));
		},
	);

	test.prop([firingArbitrary])("moves exactly the tokens of the arcs", ({ transition, binding, marking }) => {
		const fired = fire(transition, binding, marking);
		fc.pre(fired.ok);
		const taken = transition.inputs.reduce(
			(sum, arc) => sum + (arc.variables !== undefined ? arc.variables.length : arc.expression(binding).length),
			0,
		);
		const given = transition.outputs.reduce((sum, arc) => sum + arc.expression(binding).length, 0);
		expect(countTokens(fired.value)).toBe(countTokens(marking) - taken + given);
	});

	test.prop([firingArbitrary])("does not change the marking it reads", ({ transition, binding, marking }) => {
		const before = canonical(marking);
		fire(transition, binding, marking);
		enabledBindings(transition, marking);
		expect(canonical(marking)).toBe(before);
	});
});
