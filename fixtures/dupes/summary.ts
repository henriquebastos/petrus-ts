// Planted defect: the gate copies this file into two packages; Fallow must report lines 2-31 (30 lines) as one clone group.
export type Occurrence = { readonly transition: string; readonly at: number };

export type Summary = { readonly count: number; readonly first: number; readonly last: number; readonly busiest: string };

export function summarize(occurrences: readonly Occurrence[]): Summary | undefined {
	const first = occurrences[0];
	if (first === undefined) {
		return undefined;
	}
	const counts = new Map<string, number>();
	let last = first.at;
	for (const occurrence of occurrences) {
		counts.set(occurrence.transition, (counts.get(occurrence.transition) ?? 0) + 1);
		if (occurrence.at > last) {
			last = occurrence.at;
		}
	}
	let busiest = first.transition;
	let most = 0;
	for (const [transition, count] of counts) {
		if (count > most) {
			busiest = transition;
			most = count;
		}
	}
	return { count: occurrences.length, first: first.at, last, busiest };
}

export const summaryVersion = 1;
export const summaryFields = ["count", "first", "last", "busiest"] as const;
