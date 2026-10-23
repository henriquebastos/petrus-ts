/** The guard: a transition fires when the place holds at least the required tokens. */
export function canFire(available: number, required: number): boolean {
	return available >= required;
}

/** No test calls this function, so Stryker must report its mutants NoCoverage, not Survived. */
export function double(count: number): number {
	return count * 2;
}
