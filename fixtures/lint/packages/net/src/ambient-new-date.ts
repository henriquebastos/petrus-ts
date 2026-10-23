// expect: no-restricted-syntax
// Planted defect: the wall clock, through the constructor.
export function ambient(): unknown {
	return new Date();
}
