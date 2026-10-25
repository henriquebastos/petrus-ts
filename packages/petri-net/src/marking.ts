import type { PlaceId } from "./ids.ts";
import type { KeyedToken, Token, TokenCounts } from "./token.ts";
import { countKeys, keyedTokens, takeTokens, tokenKey } from "./token.ts";

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

/** The tokens of each place of one marking, with their keys, and how many tokens of each key the place holds. */
export type KeyedMarking = {
	readonly tokens: (place: PlaceId) => readonly KeyedToken[];
	readonly counts: (place: PlaceId) => TokenCounts;
};

/**
 * Reads `marking` place by place. It computes the key of each token once, when its place is first read, so that
 * many checks against one marking cost the tokens they take, not the tokens on the place.
 */
export function keyedMarking(marking: Marking): KeyedMarking {
	const places = new Map<PlaceId, KeyedPlace>();
	const read = (place: PlaceId): KeyedPlace => {
		const known = places.get(place) ?? keyedPlace(tokensAt(marking, place));
		places.set(place, known);
		return known;
	};
	return { tokens: (place) => read(place).tokens, counts: (place) => read(place).counts };
}

type KeyedPlace = { readonly tokens: readonly KeyedToken[]; readonly counts: TokenCounts };

function keyedPlace(tokens: readonly Token[]): KeyedPlace {
	const keyed = keyedTokens(tokens);
	return { tokens: keyed, counts: countKeys(keyed) };
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
