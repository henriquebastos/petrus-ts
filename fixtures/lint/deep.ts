// expect: max-depth
export function deep(rows: readonly (readonly number[])[]): number {
	let found = 0;
	for (const row of rows) {
		for (const cell of row) {
			if (cell > 0) {
				if (cell < 10) {
					if (cell % 2 === 0) {
						found += 1;
					}
				}
			}
		}
	}
	return found;
}
