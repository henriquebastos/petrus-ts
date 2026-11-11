import type { KeyedToken, Token } from "./token.ts";
import { tokenKey } from "./token.ts";

/** Arrival numbers preserve both the stored order and the representative of equal tokens. */
export type PlaceIndex = {
	nextSeq: number;
	readonly tokens: Map<number, KeyedToken>;
	readonly copies: Map<string, Map<number, Token>>;
	readonly stored: number[];
};

export function emptyPlaceIndex(): PlaceIndex {
	return { nextSeq: 0, tokens: new Map(), copies: new Map(), stored: [] };
}

export function appendIndexed(place: PlaceIndex, token: Token): string {
	const key = tokenKey(token);
	const seq = place.nextSeq++;
	const copies = place.copies.get(key) ?? new Map<number, Token>();
	copies.set(seq, token);
	place.copies.set(key, copies);
	place.tokens.set(seq, { key, token });
	place.stored.push(seq);
	return key;
}

export function frontAt(place: PlaceIndex, key: string): readonly [number, Token] | undefined {
	return place.copies.get(key)?.entries().next().value;
}

export function removeIndexed(place: PlaceIndex, key: string): number {
	const front = frontAt(place, key);
	if (front === undefined) {
		throw new RangeError(`the indexed place holds no token ${key}`);
	}
	const [seq] = front;
	const copies = place.copies.get(key);
	copies?.delete(seq);
	if (copies?.size === 0) {
		place.copies.delete(key);
	}
	place.tokens.delete(seq);
	const index = storedIndex(place.stored, seq);
	place.stored.splice(index, 1);
	return index;
}

function storedIndex(stored: readonly number[], seq: number): number {
	let low = 0;
	let high = stored.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if ((stored[middle] ?? Infinity) < seq) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
}
