import type { PlaceId } from "./ids.ts";

/**
 * The number of tokens on each place. A place that is not listed holds no tokens.
 * It is a plain JSON object, so it can be stored as a document without conversion.
 */
export type Marking = Readonly<Record<PlaceId, number>>;

export const emptyMarking: Marking = {};

export function tokensAt(marking: Marking, place: PlaceId): number {
	return marking[place] ?? 0;
}

/** Returns a new marking with `delta` added to `place`. A place that reaches zero is removed. */
export function addTokens(marking: Marking, place: PlaceId, delta: number): Marking {
	const next = tokensAt(marking, place) + delta;
	if (next === 0) {
		const { [place]: _removed, ...rest } = marking;
		return rest;
	}
	return { ...marking, [place]: next };
}
