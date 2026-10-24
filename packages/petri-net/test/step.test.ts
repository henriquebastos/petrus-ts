import { test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import type { BindingElement, ColourSet, Marking, Net, Place, SelectionPolicy, Transition } from "../src/index.ts";
import {
	definitionOrder,
	enabledBindings,
	enabledElements,
	fire,
	fireStep,
	placeId,
	transitionId,
} from "../src/index.ts";
import { canonical, markingArbitrary, netArbitrary, places, policyArbitrary } from "./arbitraries.ts";
import type { Model } from "./model-property.ts";
import { modelEnables, modelGive, modelTake, ownTokens } from "./model-property.ts";

const text: ColourSet = { name: "Text", contains: (token) => typeof token === "string" };
const comments: Place = { id: placeId("comments"), colourSet: text };
const resource: Place = { id: placeId("resource"), colourSet: text };
const replies: Place = { id: placeId("replies"), colourSet: text };

/** A comment token is "author@pr". Answering it holds the resource token of its pull request. */
const answer: Transition<"c" | "r"> = {
	id: transitionId("answer"),
	variables: { c: text, r: text },
	guard: ({ c, r }) => typeof c === "string" && typeof r === "string" && c.endsWith(`@${r}`),
	inputs: [
		{ place: comments, variables: ["c"] },
		{ place: resource, variables: ["r"] },
	],
	outputs: [
		{ place: replies, expression: ({ c }) => [c] },
		{ place: resource, expression: ({ r }) => [r] },
	],
};

/** Closes a pull request once it has a reply. It comes second in the net, so its elements come second. */
const close: Transition<"c"> = {
	id: transitionId("close"),
	variables: { c: text },
	guard: () => true,
	inputs: [{ place: replies, variables: ["c"] }],
	outputs: [],
};

const net: Net = { places: [comments, resource, replies], transitions: [answer, close] };
const marking: Marking = {
	[replies.id]: ["dan@pr-3"],
	[comments.id]: ["ana@pr-1", "carl@pr-1", "bob@pr-2"],
	[resource.id]: ["pr-1", "pr-2"],
};

const closeDan: BindingElement = { transition: close.id, binding: { c: "dan@pr-3" } };

function element(c: string, r: string): BindingElement {
	return { transition: answer.id, binding: { c, r } };
}

describe("fireStep, examples", () => {
	test("lists the enabled binding elements: transitions in definition order, then their bindings", () => {
		expect(enabledElements(net, marking)).toStrictEqual([
			element("ana@pr-1", "pr-1"),
			element("carl@pr-1", "pr-1"),
			element("bob@pr-2", "pr-2"),
			closeDan,
		]);
	});

	test("fires each element whose tokens are still free, so one resource token admits one answer per step", () => {
		expect(fireStep(net, marking, definitionOrder)).toStrictEqual({
			fired: [element("ana@pr-1", "pr-1"), element("bob@pr-2", "pr-2"), closeDan],
			marking: {
				[comments.id]: ["carl@pr-1"],
				[resource.id]: ["pr-1", "pr-2"],
				[replies.id]: ["ana@pr-1", "bob@pr-2"],
			},
		});
	});

	test("the policy's order decides which element gets a shared token", () => {
		const reversed: SelectionPolicy = (enabled) => [...enabled].reverse();
		expect(fireStep(net, marking, reversed).fired).toStrictEqual([
			closeDan,
			element("bob@pr-2", "pr-2"),
			element("carl@pr-1", "pr-1"),
		]);
	});

	test("an element that the policy filters out does not fire", () => {
		const onlyPr2: SelectionPolicy = (enabled) => enabled.filter((candidate) => candidate.binding.r === "pr-2");
		expect(fireStep(net, marking, onlyPr2).fired).toStrictEqual([element("bob@pr-2", "pr-2")]);
	});

	test("a token that the step produces is not used in the same step", () => {
		const first = fireStep(
			net,
			{ [comments.id]: ["ana@pr-1", "carl@pr-1"], [resource.id]: ["pr-1"] },
			definitionOrder,
		);
		expect(first.fired).toStrictEqual([element("ana@pr-1", "pr-1")]);
		expect(fireStep(net, first.marking, definitionOrder).fired).toStrictEqual([
			element("carl@pr-1", "pr-1"),
			{ transition: close.id, binding: { c: "ana@pr-1" } },
		]);
	});

	test("fires nothing and returns the same marking when nothing is enabled", () => {
		const idle = { [comments.id]: ["ana@pr-1"] };
		expect(fireStep(net, idle, definitionOrder)).toStrictEqual({ fired: [], marking: idle });
	});

	test("a policy that names a transition outside the net is a bug, so it throws", () => {
		const invents: SelectionPolicy = () => [{ transition: transitionId("ghost"), binding: {} }];
		expect(() => fireStep(net, marking, invents)).toThrow(
			new Error("the policy chose ghost, which is not a transition of the net"),
		);
	});
});

/** The model's step: walk the policy's list, take what the remaining tokens allow, then give every output. */
function modelStep(model: Model, testNet: Net, chosen: readonly BindingElement[]): readonly BindingElement[] {
	const taken = chosen.flatMap((candidate) => {
		const transition = testNet.transitions.find((each) => each.id === candidate.transition);
		if (transition === undefined) {
			throw new Error(`no transition ${candidate.transition}`);
		}
		if (!modelEnables(model.tokens, transition, candidate.binding)) {
			return [];
		}
		modelTake(model, transition, candidate.binding);
		return [{ candidate, transition }];
	});
	for (const { candidate, transition } of taken) {
		modelGive(model, transition, candidate.binding);
	}
	return taken.map(({ candidate }) => candidate);
}

describe("fireStep, properties", () => {
	test.prop([netArbitrary, markingArbitrary])(
		"lists the enabled elements transition by transition, in definition order",
		(testNet, start) => {
			const expected = testNet.transitions.flatMap((transition) =>
				enabledBindings(transition, start).map((binding) => ({ transition: transition.id, binding })),
			);
			expect(enabledElements(testNet, start)).toStrictEqual(expected);
		},
	);

	test.prop([netArbitrary, markingArbitrary, policyArbitrary])(
		"replaying the fired elements one by one gives the step's tokens",
		(testNet, start, policy) => {
			const step = fireStep(testNet, start, policy);
			const replayed = step.fired.reduce((current, { transition, binding }) => {
				const found = testNet.transitions.find((each) => each.id === transition);
				const fired = found === undefined ? undefined : fire(found, binding, current);
				if (fired?.ok !== true) {
					throw new Error(`replay could not fire ${transition}`);
				}
				return fired.value;
			}, start);
			for (const place of places) {
				expect(canonical(ownTokens(replayed, place.id))).toBe(canonical(ownTokens(step.marking, place.id)));
			}
		},
	);

	test.prop([netArbitrary, markingArbitrary, policyArbitrary])(
		"fires the elements and gives the marking that the model's allocation gives",
		(testNet, start, policy) => {
			const model: Model = { tokens: new Map(places.map((place) => [place.id, [...ownTokens(start, place.id)]])) };
			const expected = modelStep(model, testNet, policy(enabledElements(testNet, start)));
			const step = fireStep(testNet, start, policy);
			expect(step.fired.map(canonical)).toStrictEqual(expected.map(canonical));
			for (const place of places) {
				expect(canonical(ownTokens(step.marking, place.id))).toBe(canonical(model.tokens.get(place.id) ?? []));
			}
		},
	);
});
