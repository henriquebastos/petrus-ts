// expect: no-restricted-properties
// Planted defect: the wall clock, read directly.
export function ambient(): unknown {
	return Date.now();
}
