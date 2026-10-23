// expect: TS2375 TS18048 TS9010
// exactOptionalPropertyTypes: "absent" and "present but undefined" are different.
type Options = { readonly timeoutMs?: number };
export const options: Options = { timeoutMs: undefined };

// noUncheckedIndexedAccess: an index read can miss.
export function firstWeight(weights: readonly { readonly weight: number }[]): number {
	const first = weights[0];
	return first.weight;
}

// isolatedDeclarations: every exported value needs a written type, so declarations can be emitted without the checker.
export const doubled = [1, 2].map((weight) => weight * 2);
