import type { Marking } from "./marking.ts";
import type { ColourSet, Net, Place, Transition } from "./net.ts";
import { tokenKey } from "./token.ts";

/**
 * Lists what makes a net unusable: an id used twice, an arc to a place that is not in the net, a variable that is
 * not declared or is on no input arc, or a variable whose colour set is not the colour set of a place it takes from.
 * An empty list means the net is well formed. A runtime refuses a net with problems.
 */
export function netProblems(net: Net): readonly string[] {
	return [
		...duplicateIds(net.places.map((place) => place.id)),
		...duplicateIds(net.transitions.map((transition) => transition.id)),
		...net.transitions.flatMap((transition) => arcProblems(net, transition)),
		...net.transitions.flatMap(variableProblems),
	];
}

/**
 * Lists what makes a marking wrong for the net: a place that is not in the net, a place listed with no tokens,
 * or a token outside its place's colour set. An empty list means the marking is a marking of the net.
 */
export function markingProblems(net: Net, marking: Marking): readonly string[] {
	return Object.entries(marking).flatMap(([id, tokens]) => {
		const place = net.places.find((candidate) => candidate.id === id);
		if (place === undefined) {
			return [`marking: place ${id} is not in the net`];
		}
		const empty = tokens.length === 0 ? [`marking: place ${id} is listed with no tokens`] : [];
		const outside = tokens
			.filter((token) => !place.colourSet.contains(token))
			.map((token) => `marking: ${tokenKey(token)} on ${id} is not in ${place.colourSet.name}`);
		return [...empty, ...outside];
	});
}

function duplicateIds(ids: readonly string[]): readonly string[] {
	const uses = new Map<string, number>();
	for (const id of ids) {
		uses.set(id, (uses.get(id) ?? 0) + 1);
	}
	return [...uses].filter(([, count]) => count > 1).map(([id, count]) => `${id}: id used ${String(count)} times`);
}

function arcProblems(net: Net, transition: Transition): readonly string[] {
	return [...transition.inputs, ...transition.outputs]
		.filter((arc) => !net.places.includes(arc.place))
		.map((arc) => `${transition.id}: place ${arc.place.id} is not in the net`);
}

type VariableUse = { readonly place: Place; readonly variable: string; readonly colourSet: ColourSet | undefined };

function variableProblems(transition: Transition): readonly string[] {
	const declared = new Map(Object.entries(transition.variables));
	const uses = transition.inputs.flatMap((arc) =>
		arc.variables.map((variable) => ({ place: arc.place, variable, colourSet: declared.get(variable) })),
	);
	const unused = [...declared.keys()]
		.filter((variable) => !uses.some((use) => use.variable === variable))
		.map((variable) => `${transition.id}: variable ${variable} is on no input arc`);
	return [...unused, ...uses.flatMap((use) => useProblems(transition, use))];
}

function useProblems(transition: Transition, use: VariableUse): readonly string[] {
	if (use.colourSet === undefined) {
		return [`${transition.id}: variable ${use.variable} on ${use.place.id} is not declared`];
	}
	if (use.colourSet === use.place.colourSet) {
		return [];
	}
	return [
		`${transition.id}: variable ${use.variable} has colour set ${use.colourSet.name}, place ${use.place.id} has ${use.place.colourSet.name}`,
	];
}
