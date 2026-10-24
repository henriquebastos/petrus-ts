import { consume, enabledBindings, produce, whyNot } from "./fire.ts";
import type { TransitionId } from "./ids.ts";
import type { Marking } from "./marking.ts";
import type { Binding, Net, Transition } from "./net.ts";

/** A transition and a binding of its variables: what fires. */
export type BindingElement = { readonly transition: TransitionId; readonly binding: Binding };

/**
 * Orders and filters the enabled binding elements, for example by priority. It must be pure and deterministic.
 * It may list an element twice to fire it twice when the tokens allow. It cannot make two elements share a token:
 * allocation in `fireStep` prevents that.
 */
export type SelectionPolicy = (enabled: readonly BindingElement[]) => readonly BindingElement[];

/** What a step fired, in firing order, and the marking after it. */
export type FiredStep = { readonly fired: readonly BindingElement[]; readonly marking: Marking };

/** The default policy: it keeps the order of `enabledElements`. A policy that sorts stably keeps it as its tie-break. */
export const definitionOrder: SelectionPolicy = (enabled) => enabled;

/**
 * Every enabled binding element: transitions in definition order, then `enabledBindings` order. It is the list a
 * policy gets, and a host can show it as what could fire now.
 */
export function enabledElements(net: Net, marking: Marking): readonly BindingElement[] {
	return net.transitions.flatMap((transition) =>
		enabledBindings(transition, marking).map((binding) => ({ transition: transition.id, binding })),
	);
}

type Allocation = {
	readonly remaining: Marking;
	readonly taken: readonly { readonly element: BindingElement; readonly transition: Transition }[];
};

/**
 * Selects a step and fires it (Jensen: a step occurs). The policy orders and filters the enabled binding elements.
 * Allocation then walks that list and takes each element whose input tokens are still in what the elements before it
 * left, so no two elements share a token. The taken elements fire together: their input tokens come from `marking`,
 * and their output tokens are added after, in firing order, so no element uses a token that the same step produced.
 * An element that the policy names with a transition outside the net is a bug in the policy, so it throws an Error.
 */
export function fireStep(net: Net, marking: Marking, policy: SelectionPolicy): FiredStep {
	const byId = new Map(net.transitions.map((transition) => [transition.id, transition]));
	const allocation = policy(enabledElements(net, marking)).reduce<Allocation>(
		(sofar, element) => {
			const transition = byId.get(element.transition);
			if (transition === undefined) {
				throw new Error(`the policy chose ${element.transition}, which is not a transition of the net`);
			}
			if (whyNot(transition, element.binding, sofar.remaining) !== undefined) {
				return sofar;
			}
			return {
				remaining: consume(transition, element.binding, sofar.remaining),
				taken: [...sofar.taken, { element, transition }],
			};
		},
		{ remaining: marking, taken: [] },
	);
	return {
		fired: allocation.taken.map(({ element }) => element),
		marking: allocation.taken.reduce(
			(next, { element, transition }) => produce(transition, element.binding, next),
			allocation.remaining,
		),
	};
}
