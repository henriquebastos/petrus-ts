// expect: @eslint-community/eslint-comments/require-description
export function parse(body: string): number {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const data: { readonly count: number } = JSON.parse(body);
	return data.count;
}
