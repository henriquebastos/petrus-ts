// expect: no-restricted-globals
// Planted defect: a timer that no test controls.
export function ambient(): unknown {
	return setImmediate(() => undefined);
}
