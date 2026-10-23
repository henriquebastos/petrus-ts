// expect: no-restricted-properties
// Planted defect: the monotonic clock, read directly.
export function ambient(): unknown {
	return performance.now();
}
