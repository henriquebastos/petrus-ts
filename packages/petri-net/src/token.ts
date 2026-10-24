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

/** Each token once, in the order it first occurs. */
export function distinctTokens(tokens: readonly Token[]): readonly Token[] {
	const seen = new Set<string>();
	return tokens.filter((token) => {
		const key = tokenKey(token);
		const fresh = !seen.has(key);
		seen.add(key);
		return fresh;
	});
}

/**
 * Takes one equal token from `available` for each token in `wanted`, counting repeats (multiset difference).
 * `left` is what stays, in its order. `missing` lists each wanted token that `available` could not give.
 */
export function takeTokens(
	available: readonly Token[],
	wanted: readonly Token[],
): { readonly left: readonly Token[]; readonly missing: readonly Token[] } {
	const left = [...available];
	const missing: Token[] = [];
	for (const token of wanted) {
		const key = tokenKey(token);
		const index = left.findIndex((candidate) => tokenKey(candidate) === key);
		if (index < 0) {
			missing.push(token);
		} else {
			left.splice(index, 1);
		}
	}
	return { left, missing };
}
