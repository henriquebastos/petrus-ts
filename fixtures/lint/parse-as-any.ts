// expect: @typescript-eslint/no-explicit-any @typescript-eslint/no-unnecessary-type-assertion @typescript-eslint/no-unsafe-assignment @typescript-eslint/no-unsafe-member-access @typescript-eslint/no-unsafe-return
export function readNumber(body: string): number {
	const data = JSON.parse(body) as any;
	return data.number;
}
