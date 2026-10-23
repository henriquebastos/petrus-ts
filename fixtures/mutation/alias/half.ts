// Only a runtime test calls this, through `@petrus/net`. Its mutant is Killed only if that import loads the mutated copy.
export function half(count: number): number {
	return count / 2;
}
