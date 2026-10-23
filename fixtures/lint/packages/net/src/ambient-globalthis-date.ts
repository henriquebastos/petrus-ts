// expect: no-restricted-syntax
// Planted defect: the wall clock, reached through globalThis.
export function ambient(): unknown {
	return globalThis.Date.now();
}
