import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import type { Binding, Marking, PlaceId, Token, Transition } from "../src/index.ts";
import { enabledBindings, fire } from "../src/index.ts";
import { canonical, markingArbitrary, places, transitionArbitrary } from "./arbitraries.ts";
import { modelEnables, modelProperty, ownTokens } from "./model-property.ts";

/** Every assignment of the tokens in the marking to the variables: the model's search space. */
function allAssignments(transition: Transition, marking: Marking): readonly Binding[] {
	const tokens = places.flatMap((place) => ownTokens(marking, place.id));
	return Object.keys(transition.variables).reduce<readonly Binding[]>(
		(partials, variable) => partials.flatMap((partial) => tokens.map((token) => ({ ...partial, [variable]: token }))),
		[{}],
	);
}

function tokenMap(marking: Marking): ReadonlyMap<PlaceId, readonly Token[]> {
	return new Map(places.map((place) => [place.id, ownTokens(marking, place.id)]));
}

describe("fire against a reference model", () => {
	test("any sequence of firings matches the model", () => {
		fc.assert(modelProperty(fire));
	});

	test.prop([transitionArbitrary, markingArbitrary])(
		"enabledBindings lists each binding the model enables, once",
		(transition, marking) => {
			const listed = enabledBindings(transition, marking).map(canonical);
			const expected = new Set(
				allAssignments(transition, marking)
					.filter((binding) => modelEnables(tokenMap(marking), transition, binding))
					.map(canonical),
			);
			expect(new Set(listed)).toStrictEqual(expected);
			expect(listed.length).toBe(expected.size);
		},
	);
});
