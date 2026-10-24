import type { PlaceId } from "./ids.ts";
import type { Token } from "./token.ts";
import { takeTokens, tokenKey } from "./token.ts";

/**
 * The tokens on each place: a multiset, kept in the order the tokens arrived. A place with no tokens is not listed.
 * It is a plain JSON object, so it can be stored as a document without conversion.
 */
export type Marking = Readonly<Record<PlaceId, readonly Token[]>>;

/** The marking with no tokens on any place. */
export const emptyMarking: Marking = {};

/** Reads only the marking's own keys: a place named `constructor` or `__proto__` must not see an inherited property. */
export function tokensAt(marking: Marking, place: PlaceId): readonly Token[] {
	return (Object.hasOwn(marking, place) ? marking[place] : undefined) ?? [];
}

/** Returns a new marking with `tokens` added after the tokens already on `place`. */
export function addTokens(marking: Marking, place: PlaceId, tokens: readonly Token[]): Marking {
	return withTokens(marking, place, [...tokensAt(marking, place), ...tokens]);
}

/**
 * Returns a new marking with one equal token removed from `place` for each of `tokens`. A token that is not
 * there is a bug in the caller, so it throws a RangeError.
 */
export function removeTokens(marking: Marking, place: PlaceId, tokens: readonly Token[]): Marking {
	const { left, missing } = takeTokens(tokensAt(marking, place), tokens);
	if (missing.length > 0) {
		throw new RangeError(`place ${place} holds no token ${missing.map(tokenKey).join(", ")}`);
	}
	return withTokens(marking, place, left);
}

function withTokens(marking: Marking, place: PlaceId, tokens: readonly Token[]): Marking {
	if (tokens.length === 0) {
		const { [place]: _removed, ...rest } = marking;
		return rest;
	}
	return { ...marking, [place]: tokens };
}
