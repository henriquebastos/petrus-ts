// expect: @typescript-eslint/no-unsafe-type-assertion
type Marking = Readonly<Record<string, number>>;

export function asMarking(labels: readonly string[]): Marking {
	return labels as unknown as Marking;
}
