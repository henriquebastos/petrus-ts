import { bindingProblems, valueOf } from "./binding.ts";
import type { PlaceId, TransitionId } from "./ids.ts";
import type { KeyedMarking, Marking } from "./marking.ts";
import { addTokens, keyedMarking, removeTokens } from "./marking.ts";
import type { Binding, ExpressionInputArc, InputArc, OutputArc, Transition } from "./net.ts";
import type { Result } from "./result.ts";
import { err, ok } from "./result.ts";
import type { Token, TokenCounts } from "./token.ts";
import { difference, distinctTokens, keyedTokens, tokenKey } from "./token.ts";

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
 * places of the variable input arcs that list it. The order is fixed: variables in declaration order, then values in
 * the order of those arcs and, within a place, in arrival order. An expression input arc's token outside its place's
 * colour set is a bug in the net, so it throws a TypeError. The transition must come from a net with no problems
 * (see `netProblems`).
 */
export function enabledBindings(transition: Transition, marking: Marking): readonly Binding[] {
	return enabledBindingsIn(transition, keyedMarking(marking));
}

/** `enabledBindings` on a keyed marking, so that callers who check many transitions compute each key once. */
export function enabledBindingsIn(transition: Transition, marking: KeyedMarking): readonly Binding[] {
	return Object.keys(transition.variables)
		.reduce<readonly Binding[]>(
			(partials, variable) => {
				const values = candidates(transition, marking, variable);
				return partials.flatMap((partial) => values.map((token) => ({ ...partial, [variable]: token })));
			},
			[{}],
		)
		.filter((binding) => whyNot(transition, binding, marking.counts) === undefined);
}

/**
 * Fires the binding element (transition, binding): removes the tokens the input arcs take and adds the tokens the
 * output arcs give. It returns `not-a-binding` or `not-enabled` instead when the binding cannot fire.
 * An arc expression's token outside its place's colour set is a bug in the net, so it throws a TypeError. The
 * transition must come from a net with no problems (see `netProblems`).
 */
export function fire(
	transition: Transition,
	binding: Binding,
	marking: Marking,
): Result<Marking, NotABinding | NotEnabled> {
	const failure = whyNot(transition, binding, keyedMarking(marking).counts);
	if (failure !== undefined) {
		return err(failure);
	}
	return ok(produce(transition, binding, consume(transition, binding, marking)));
}

/** Removes the tokens that the input arcs take. The binding element must be enabled in `marking`. */
function consume(transition: Transition, binding: Binding, marking: Marking): Marking {
	return [...demandByPlace(transition, binding)].reduce(
		(next, [place, wanted]) => removeTokens(next, place, wanted),
		marking,
	);
}

/** Adds the tokens that the output arcs give, after the tokens already on each place. */
export function produce(transition: Transition, binding: Binding, marking: Marking): Marking {
	return transition.outputs.reduce(
		(next, arc) => addTokens(next, arc.place.id, expressionTokens(transition, "output", arc, binding)),
		marking,
	);
}

/**
 * Why the binding element cannot fire, or `undefined` when it is enabled. `counts` gives the tokens on each place by
 * key. The expression input arcs run only after the binding has no problems.
 */
export function whyNot(
	transition: Transition,
	binding: Binding,
	counts: (place: PlaceId) => TokenCounts,
): NotABinding | NotEnabled | undefined {
	const problems = bindingProblems(transition, binding);
	if (problems.length > 0) {
		return { kind: "not-a-binding", transition: transition.id, problems };
	}
	const shortfalls = [...demandByPlace(transition, binding)]
		.map(([place, wanted]) => ({ place, missing: difference(keyedTokens(wanted), counts(place)) }))
		.filter((shortfall) => shortfall.missing.length > 0);
	return shortfalls.length > 0 ? { kind: "not-enabled", transition: transition.id, shortfalls } : undefined;
}

function candidates(transition: Transition, marking: KeyedMarking, variable: string): readonly Token[] {
	return distinctTokens(
		transition.inputs
			.filter((arc) => arc.variables?.includes(variable) === true)
			.flatMap((arc) => marking.tokens(arc.place.id)),
	);
}

/** Two arcs from the same place add up, so the check sees all the tokens the binding takes there. */
export function demandByPlace(transition: Transition, binding: Binding): ReadonlyMap<PlaceId, readonly Token[]> {
	const demand = new Map<PlaceId, readonly Token[]>();
	for (const arc of transition.inputs) {
		demand.set(arc.place.id, [...(demand.get(arc.place.id) ?? []), ...taken(transition, arc, binding)]);
	}
	return demand;
}

function taken(transition: Transition, arc: InputArc, binding: Binding): readonly Token[] {
	return arc.variables !== undefined
		? arc.variables.map((variable) => valueOf(binding, variable))
		: expressionTokens(transition, "input", arc, binding);
}

/** The tokens of an input or output arc expression. A token outside the place's colour set is a bug in the net. */
export function expressionTokens(
	transition: Transition,
	side: "input" | "output",
	arc: ExpressionInputArc | OutputArc,
	binding: Binding,
): readonly Token[] {
	const tokens = arc.expression(binding);
	const outside = tokens.filter((token) => !arc.place.colourSet.contains(token));
	if (outside.length > 0) {
		throw new TypeError(
			`${transition.id}: ${side} ${outside.map(tokenKey).join(", ")} on ${arc.place.id} is not in ${arc.place.colourSet.name}`,
		);
	}
	return tokens;
}
