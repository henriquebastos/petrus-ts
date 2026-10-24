// expect: max-depth
// Depth 5 at complexity 5: the try block nests without adding a branch, so only max-depth reports.
export function deep(rows: readonly (readonly number[])[], log: (cell: number) => void): number {
	let found = 0;
	for (const row of rows) {
		for (const cell of row) {
			if (cell > 0) {
				if (cell % 2 === 0) {
					try {
						found += 1;
					} finally {
						log(cell);
					}
				}
			}
		}
	}
	return found;
}
