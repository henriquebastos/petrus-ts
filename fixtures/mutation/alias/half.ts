// Only a runtime test calls this, through `@petrus/petri-net`. Its mutant is Killed only if that import loads the mutated copy.
export function half(count: number): number {
	return count / 2;
}
