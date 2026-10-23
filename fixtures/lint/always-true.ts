// expect: @typescript-eslint/no-unnecessary-condition @typescript-eslint/strict-boolean-expressions
type Marking = Readonly<Record<string, number>>;

export function describeMarking(marking: Marking): string {
	if (marking) {
		return JSON.stringify(marking);
	}
	return "none";
}
