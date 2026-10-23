import type { Transition } from "./transition.ts";

/**
 * Lists what makes a net unusable: an arc weight that is not a positive integer, or an id used twice.
 * An empty list means the net is well formed. A runtime refuses a net with problems.
 */
export function netProblems(transitions: readonly Transition[]): readonly string[] {
	return [...transitions.flatMap(weightProblems), ...duplicateIds(transitions)];
}

function weightProblems(transition: Transition): readonly string[] {
	return [...transition.inputs, ...transition.outputs]
		.filter((arc) => !Number.isInteger(arc.weight) || arc.weight < 1)
		.map((arc) => `${transition.id}: weight ${String(arc.weight)} on ${arc.place} is not a positive integer`);
}

function duplicateIds(transitions: readonly Transition[]): readonly string[] {
	const uses = new Map<string, number>();
	for (const transition of transitions) {
		uses.set(transition.id, (uses.get(transition.id) ?? 0) + 1);
	}
	return [...uses].filter(([, count]) => count > 1).map(([id, count]) => `${id}: id used ${String(count)} times`);
}
