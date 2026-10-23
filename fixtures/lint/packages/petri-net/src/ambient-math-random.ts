// expect: no-restricted-properties
// Planted defect: randomness that no seed controls.
export function ambient(): unknown {
	return Math.random();
}
