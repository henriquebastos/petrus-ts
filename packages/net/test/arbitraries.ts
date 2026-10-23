import fc from "fast-check";
import type { Arc, Marking, PlaceId, Transition } from "../src/index.ts";
import { placeId, transitionId } from "../src/index.ts";

/** A small pool of places, so generated transitions often share places and interact. */
export const places: readonly PlaceId[] = ["a", "b", "c", "d"].map(placeId);

const placeArbitrary: fc.Arbitrary<PlaceId> = fc.constantFrom(...places);

const arcArbitrary: fc.Arbitrary<Arc> = fc.record({
	place: placeArbitrary,
	weight: fc.integer({ min: 1, max: 3 }),
});

export const transitionArbitrary: fc.Arbitrary<Transition> = fc.record({
	id: fc.constantFrom("t1", "t2", "t3").map(transitionId),
	inputs: fc.array(arcArbitrary, { maxLength: 3 }),
	outputs: fc.array(arcArbitrary, { maxLength: 3 }),
});

export const markingArbitrary: fc.Arbitrary<Marking> = fc
	.tuple(...places.map(() => fc.integer({ min: 0, max: 4 })))
	.map((counts) =>
		Object.fromEntries(
			places.flatMap((place, index) => {
				const count = counts[index] ?? 0;
				return count > 0 ? [[place, count]] : [];
			}),
		),
	);

export function totalTokens(marking: Marking): number {
	return Object.values<number>(marking).reduce((sum, count) => sum + count, 0);
}

export function totalWeight(arcs: readonly Arc[]): number {
	return arcs.reduce((sum, arc) => sum + arc.weight, 0);
}
