import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import type { Transition } from "../src/index.ts";
import { fire, isEnabled, placeId, shortfalls, tokensAt, transitionId } from "../src/index.ts";
import { markingArbitrary, totalTokens, totalWeight, transitionArbitrary } from "./arbitraries.ts";

const inbox = placeId("inbox");
const done = placeId("done");
const review: Transition = {
	id: transitionId("review"),
	inputs: [{ place: inbox, weight: 2 }],
	outputs: [{ place: done, weight: 1 }],
};

describe("fire, examples", () => {
	test("consumes the input weight and produces the output weight", () => {
		const fired = fire(review, { [inbox]: 3 });
		expect(fired).toStrictEqual({ ok: true, value: { [inbox]: 1, [done]: 1 } });
	});

	test("removes a place that reaches zero tokens", () => {
		expect(fire(review, { [inbox]: 2 })).toStrictEqual({ ok: true, value: { [done]: 1 } });
	});

	test("reports each shortfall when the transition is not enabled", () => {
		expect(fire(review, { [inbox]: 1 })).toStrictEqual({
			ok: false,
			error: {
				kind: "not-enabled",
				transition: review.id,
				shortfalls: [{ place: inbox, required: 2, available: 1 }],
			},
		});
	});

	test("adds the weights of two arcs from the same place", () => {
		const twice: Transition = {
			...review,
			inputs: [review.inputs[0] ?? { place: inbox, weight: 1 }, { place: inbox, weight: 1 }],
		};
		expect(isEnabled(twice, { [inbox]: 2 })).toBe(false);
		expect(isEnabled(twice, { [inbox]: 3 })).toBe(true);
	});
});

describe("fire, properties", () => {
	test.prop([transitionArbitrary, markingArbitrary])(
		"is enabled exactly when it has no shortfalls",
		(transition, marking) => {
			expect(isEnabled(transition, marking)).toBe(shortfalls(transition, marking).length === 0);
			expect(fire(transition, marking).ok).toBe(isEnabled(transition, marking));
		},
	);

	test.prop([transitionArbitrary, markingArbitrary])("moves exactly the arc weights", (transition, marking) => {
		const fired = fire(transition, marking);
		fc.pre(fired.ok);
		const expected = totalTokens(marking) - totalWeight(transition.inputs) + totalWeight(transition.outputs);
		expect(totalTokens(fired.value)).toBe(expected);
	});

	test.prop([transitionArbitrary, markingArbitrary])(
		"never leaves a negative or zero count",
		(transition, marking) => {
			const fired = fire(transition, marking);
			if (fired.ok) {
				expect(Object.values<number>(fired.value).every((count) => count > 0)).toBe(true);
			}
		},
	);

	test.prop([transitionArbitrary, markingArbitrary])("does not change the marking it reads", (transition, marking) => {
		const before = { ...marking };
		fire(transition, marking);
		expect(marking).toStrictEqual(before);
	});

	test.prop([transitionArbitrary, markingArbitrary])(
		"reports the real token count of each short place",
		(transition, marking) => {
			for (const shortfall of shortfalls(transition, marking)) {
				expect(shortfall.available).toBe(tokensAt(marking, shortfall.place));
				expect(shortfall.available).toBeLessThan(shortfall.required);
			}
		},
	);
});
