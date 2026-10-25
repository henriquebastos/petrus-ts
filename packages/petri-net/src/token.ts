/**
 * A token's value: plain JSON, so a marking is a document that a store keeps without conversion.
 * Two tokens are equal when their JSON values are equal. The order of object keys does not count.
 */
export type Token = null | boolean | number | string | readonly Token[] | { readonly [key: string]: Token };

/** The same text for equal tokens: object keys are sorted first. */
export function tokenKey(token: Token): string {
	return JSON.stringify(token, sortKeys);
}

function sortKeys(_key: string, value: unknown): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return value;
	}
	const entries = new Map(Object.entries(value));
	return Object.fromEntries([...entries.keys()].sort().map((key) => [key, entries.get(key)]));
}

/** A token with its `tokenKey`, so that each multiset operation computes the key once. */
export type KeyedToken = { readonly token: Token; readonly key: string };

/** How many tokens of each key a multiset holds. A key it does not hold is not listed. */
export type TokenCounts = ReadonlyMap<string, number>;

/** Each token with its key, in the same order. */
export function keyedTokens(tokens: readonly Token[]): readonly KeyedToken[] {
	return tokens.map((token) => ({ token, key: tokenKey(token) }));
}

/** How many of the tokens have each key. */
export function countKeys(tokens: readonly KeyedToken[]): TokenCounts {
	const counts = new Map<string, number>();
	for (const { key } of tokens) {
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

/**
 * The multiset difference `tokens - counts`, in the order of `tokens`: of each key, the first `counts.get(key)`
 * tokens go and the later ones stay.
 */
export function difference(tokens: readonly KeyedToken[], counts: TokenCounts): readonly Token[] {
	const seen = new Map<string, number>();
	return tokens
		.filter(({ key }) => {
			const occurrence = (seen.get(key) ?? 0) + 1;
			seen.set(key, occurrence);
			return occurrence > (counts.get(key) ?? 0);
		})
		.map(({ token }) => token);
}

/** Each token once, in the order it first occurs. */
export function distinctTokens(tokens: readonly KeyedToken[]): readonly Token[] {
	const seen = new Set<string>();
	return tokens
		.filter(({ key }) => {
			const fresh = !seen.has(key);
			seen.add(key);
			return fresh;
		})
		.map(({ token }) => token);
}

/**
 * Takes one equal token from `available` for each token in `wanted`, counting repeats (multiset difference).
 * `left` is what stays, in its order. `missing` lists each wanted token that `available` could not give.
 */
export function takeTokens(
	available: readonly Token[],
	wanted: readonly Token[],
): { readonly left: readonly Token[]; readonly missing: readonly Token[] } {
	const keyedAvailable = keyedTokens(available);
	const keyedWanted = keyedTokens(wanted);
	return {
		left: difference(keyedAvailable, countKeys(keyedWanted)),
		missing: difference(keyedWanted, countKeys(keyedAvailable)),
	};
}
