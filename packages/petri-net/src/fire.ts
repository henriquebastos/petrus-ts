import { bindingProblems, valueOf } from "./binding.ts";
import type { PlaceId, TransitionId } from "./ids.ts";
import type { Marking } from "./marking.ts";
import { addTokens, removeTokens, tokensAt } from "./marking.ts";
import type { Binding, OutputArc, Transition } from "./net.ts";
import type { Result } from "./result.ts";
import { err, ok } from "./result.ts";
import type { Token } from "./token.ts";
import { distinctTokens, takeTokens, tokenKey } from "./token.ts";

/** One input place that lacks tokens the binding takes. */
export type Shortfall = { readonly place: PlaceId; readonly missing: readonly Token[] };

/** The values are not a binding of the transition. Each problem is one sentence. */
export type NotABinding = {
	readonly kind: "not-a-binding";
	readonly transition: TransitionId;
	readonly problems: readonly string[];
};

/** The binding is right, but input places lack the tokens it takes. */
export type NotEnabled = {
	readonly kind: "not-enabled";
	readonly transition: TransitionId;
	readonly shortfalls: readonly Shortfall[];
};

/**
 * Every enabled binding of `transition` in `marking`, each once. A variable takes its candidate values from the
 * places of the input arcs that list it. The order is fixed: variables in declaration order, then values in the
 * order of those arcs and, within a place, in arrival order. The transition must come from a net with no problems
 * (see `netProblems`).
 */
export function enabledBindings(transition: Transition, marking: Marking): readonly Binding[] {
	return Object.keys(transition.variables)
		.reduce<readonly Binding[]>(
			(partials, variable) =>
				partials.flatMap((partial) =>
					candidates(transition, marking, variable).map((token) => ({ ...partial, [variable]: token })),
				),
			[{}],
		)
		.filter((binding) => whyNot(transition, binding, marking) === undefined);
}

/**
 * Fires the binding element (transition, binding): removes the tokens the input arcs take and adds the tokens the
 * output arcs give. It returns `not-a-binding` or `not-enabled` instead when the binding cannot fire.
 * An output token outside its place's colour set is a bug in the net, so it throws a TypeError. The transition must
 * come from a net with no problems (see `netProblems`).
 */
export function fire(
	transition: Transition,
	binding: Binding,
	marking: Marking,
): Result<Marking, NotABinding | NotEnabled> {
	const failure = whyNot(transition, binding, marking);
	if (failure !== undefined) {
		return err(failure);
	}
	return ok(produce(transition, binding, consume(transition, binding, marking)));
}

/** Removes the tokens that the input arcs take. The binding element must be enabled in `marking`. */
export function consume(transition: Transition, binding: Binding, marking: Marking): Marking {
	return [...demandByPlace(transition, binding)].reduce(
		(next, [place, wanted]) => removeTokens(next, place, wanted),
		marking,
	);
}

/** Adds the tokens that the output arcs give, after the tokens already on each place. */
export function produce(transition: Transition, binding: Binding, marking: Marking): Marking {
	return transition.outputs.reduce(
		(next, arc) => addTokens(next, arc.place.id, produced(transition, arc, binding)),
		marking,
	);
}

/** Why the binding element cannot fire, or `undefined` when it is enabled. */
export function whyNot(
	transition: Transition,
	binding: Binding,
	marking: Marking,
): NotABinding | NotEnabled | undefined {
	const problems = bindingProblems(transition, binding);
	if (problems.length > 0) {
		return { kind: "not-a-binding", transition: transition.id, problems };
	}
	const shortfalls = [...demandByPlace(transition, binding)]
		.map(([place, wanted]) => ({ place, missing: takeTokens(tokensAt(marking, place), wanted).missing }))
		.filter((shortfall) => shortfall.missing.length > 0);
	return shortfalls.length > 0 ? { kind: "not-enabled", transition: transition.id, shortfalls } : undefined;
}

function candidates(transition: Transition, marking: Marking, variable: string): readonly Token[] {
	return distinctTokens(
		transition.inputs
			.filter((arc) => arc.variables.includes(variable))
			.flatMap((arc) => tokensAt(marking, arc.place.id)),
	);
}

/** Two arcs from the same place add up, so the check sees all the tokens the binding takes there. */
function demandByPlace(transition: Transition, binding: Binding): ReadonlyMap<PlaceId, readonly Token[]> {
	const demand = new Map<PlaceId, readonly Token[]>();
	for (const arc of transition.inputs) {
		const wanted = arc.variables.map((variable) => valueOf(binding, variable));
		demand.set(arc.place.id, [...(demand.get(arc.place.id) ?? []), ...wanted]);
	}
	return demand;
}

function produced(transition: Transition, arc: OutputArc, binding: Binding): readonly Token[] {
	const tokens = arc.expression(binding);
	const outside = tokens.filter((token) => !arc.place.colourSet.contains(token));
	if (outside.length > 0) {
		throw new TypeError(
			`${transition.id}: output ${outside.map(tokenKey).join(", ")} on ${arc.place.id} is not in ${arc.place.colourSet.name}`,
		);
	}
	return tokens;
}
