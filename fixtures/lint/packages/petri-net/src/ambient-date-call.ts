// expect: no-restricted-syntax
// Planted defect: the wall clock, through a plain call.
export function ambient(): unknown {
	return Date();
}
