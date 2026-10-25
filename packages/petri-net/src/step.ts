import { demandByPlace, enabledBindingsIn, produce, whyNot } from "./fire.ts";
import type { PlaceId, TransitionId } from "./ids.ts";
import type { KeyedMarking, Marking } from "./marking.ts";
import { keyedMarking, removeTokens } from "./marking.ts";
import type { Binding, Net, Transition } from "./net.ts";
import type { Token } from "./token.ts";
import { tokenKey } from "./token.ts";

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
	return enabledElementsIn(net, keyedMarking(marking));
}

function enabledElementsIn(net: Net, marking: KeyedMarking): readonly BindingElement[] {
	return net.transitions.flatMap((transition) =>
		enabledBindingsIn(transition, marking).map((binding) => ({ transition: transition.id, binding })),
	);
}

type Taken = {
	readonly element: BindingElement;
	readonly transition: Transition;
	readonly demand: ReadonlyMap<PlaceId, readonly Token[]>;
};

/**
 * Selects a step and fires it (Jensen: a step occurs). The policy orders and filters the enabled binding elements.
 * Allocation then walks that list and takes each element whose input tokens are still in what the elements before it
 * left, so no two elements share a token. The taken elements fire together: their input tokens come from `marking`,
 * and their output tokens are added after, in firing order, so no element uses a token that the same step produced.
 * An element that the policy names with a transition outside the net is a bug in the policy, so it throws an Error.
 */
export function fireStep(net: Net, marking: Marking, policy: SelectionPolicy): FiredStep {
	const keyed = keyedMarking(marking);
	const taken = allocate(net, keyed, policy(enabledElementsIn(net, keyed)));
	const remaining = [...totalDemand(taken)].reduce(
		(next, [place, wanted]) => removeTokens(next, place, wanted),
		marking,
	);
	return {
		fired: taken.map(({ element }) => element),
		marking: taken.reduce((next, { element, transition }) => produce(transition, element.binding, next), remaining),
	};
}

/** Walks the elements in order and takes each one whose input tokens the ones taken before it left free. */
function allocate(net: Net, marking: KeyedMarking, elements: readonly BindingElement[]): readonly Taken[] {
	const byId = new Map(net.transitions.map((transition) => [transition.id, transition]));
	const free = new Map<PlaceId, Map<string, number>>();
	const freeAt = (place: PlaceId): Map<string, number> => {
		const counts = free.get(place) ?? new Map(marking.counts(place));
		free.set(place, counts);
		return counts;
	};
	const taken: Taken[] = [];
	for (const element of elements) {
		const transition = transitionOf(byId, element);
		if (whyNot(transition, element.binding, freeAt) === undefined) {
			const demand = demandByPlace(transition, element.binding);
			demand.forEach((wanted, place) => {
				takeFree(freeAt(place), wanted);
			});
			taken.push({ element, transition, demand });
		}
	}
	return taken;
}

function transitionOf(byId: ReadonlyMap<TransitionId, Transition>, element: BindingElement): Transition {
	const transition = byId.get(element.transition);
	if (transition === undefined) {
		throw new Error(`the policy chose ${element.transition}, which is not a transition of the net`);
	}
	return transition;
}

/** Takes `tokens` from the free counts of one place, and changes `counts`. The check before it found them all free. */
function takeFree(counts: Map<string, number>, tokens: readonly Token[]): void {
	for (const token of tokens) {
		const key = tokenKey(token);
		counts.set(key, (counts.get(key) ?? 0) - 1);
	}
}

/** The tokens that all taken elements take from each place, in firing order. */
function totalDemand(taken: readonly Taken[]): ReadonlyMap<PlaceId, readonly Token[]> {
	const total = new Map<PlaceId, Token[]>();
	for (const { demand } of taken) {
		demand.forEach((wanted, place) => {
			const tokens = total.get(place) ?? [];
			tokens.push(...wanted);
			total.set(place, tokens);
		});
	}
	return total;
}
