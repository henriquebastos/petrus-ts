import type { PlaceId } from "./ids.ts";

/**
 * The number of tokens on each place. A place that is not listed holds no tokens.
 * It is a plain JSON object, so it can be stored as a document without conversion.
 */
export type Marking = Readonly<Record<PlaceId, number>>;

/** The marking with no tokens on any place. */
export const emptyMarking: Marking = {};

/** Reads only the marking's own keys: a place named `constructor` or `__proto__` must not see an inherited property. */
export function tokensAt(marking: Marking, place: PlaceId): number {
	return Object.hasOwn(marking, place) ? (marking[place] ?? 0) : 0;
}

/**
 * Returns a new marking with `delta` added to `place`. A place that reaches zero is removed.
 * A count below zero or not an integer is a bug in the caller, so it throws a RangeError.
 */
export function addTokens(marking: Marking, place: PlaceId, delta: number): Marking {
	const next = tokensAt(marking, place) + delta;
	if (!Number.isInteger(next) || next < 0) {
		throw new RangeError(`place ${place} would hold ${String(next)} tokens`);
	}
	if (next === 0) {
		const { [place]: _removed, ...rest } = marking;
		return rest;
	}
	return { ...marking, [place]: next };
}
