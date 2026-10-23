export function label(count: number): string {
	if (count === 0) {
		return "empty";
	}
	if (count === 1) {
		return "one";
	}
	return "many";
}

// Planted defect: no test calls this function, so functions, statements and lines fall below their thresholds too.
export function plural(word: string, count: number): string {
	const suffix = count === 1 ? "" : "s";
	const text = `${String(count)} ${word}${suffix}`;
	return text;
}
