import { bindingProblems } from "./binding.ts";
import type { Candidate, TransitionIndex } from "./candidate-binding.ts";
import { compareCandidates, countsFor } from "./candidate-binding.ts";
import { expressionTokens } from "./fire.ts";
import type { PlaceId } from "./ids.ts";
import type { Changes } from "./index-notify.ts";
import { changed, notify } from "./index-notify.ts";
import type { IndexState } from "./index-state.ts";
import { countAt, placeIn } from "./index-state.ts";
import type { IndexedMarking } from "./indexed-marking.ts";
import { appendToIndex, consumeIndex, ownIndex, readIndex } from "./indexed-marking.ts";
import type { Transition } from "./net.ts";
import { removeIndexed } from "./place-index.ts";
import type { BindingElement, SelectionPolicy } from "./step.ts";

type Demand = ReadonlyMap<PlaceId, ReadonlyMap<string, number>>;
type Allocation = { readonly element: BindingElement; readonly transition: Transition; readonly demand: Demand };

/** Lists enabled elements in the same order as the pure engine without consuming the owner. */
export function enabledElementsIndexed(indexed: IndexedMarking): readonly BindingElement[] {
	return list(readIndex(indexed));
}

function list(state: IndexState): readonly BindingElement[] {
	return state.transitions.flatMap((owner) => {
		owner.listed ??= [...owner.enabled]
			.sort((left, right) => compareCandidates(left, right, state.places))
			.map((candidate) => elementFor(state, candidate));
		return owner.listed;
	});
}

function elementFor(state: IndexState, candidate: Candidate): BindingElement {
	state.bindings.set(candidate.binding, candidate);
	return { transition: candidate.owner.transition.id, binding: candidate.binding };
}

/** Consumes the owner, allocates against pre-step counts, and returns the fired elements and the new owner. */
export function stepIndexed(
	indexed: IndexedMarking,
	policy: SelectionPolicy,
): {
	readonly indexed: IndexedMarking;
	readonly fired: readonly BindingElement[];
} {
	const state = consumeIndex(indexed);
	const taken = allocate(state, policy(list(state)));
	const changes: Changes = new Map();
	removeDemand(state, totalDemand(taken), changes);
	for (const { transition, element } of taken) {
		for (const arc of transition.outputs) {
			appendToIndex(state, arc.place.id, expressionTokens(transition, "output", arc, element.binding), changes);
		}
	}
	notify(state, changes);
	return { indexed: ownIndex(state), fired: taken.map(({ element }) => element) };
}

function allocate(state: IndexState, elements: readonly BindingElement[]): readonly Allocation[] {
	const byId = new Map(state.transitions.map((owner) => [owner.transition.id, owner]));
	const reserved = new Map<PlaceId, Map<string, number>>();
	const taken: Allocation[] = [];
	for (const element of elements) {
		const owner = byId.get(element.transition);
		if (owner === undefined) {
			throw new Error(`the policy chose ${element.transition}, which is not a transition of the net`);
		}
		const demand = demandFor(state, owner, element);
		if (demand !== undefined && fits(state, reserved, demand)) {
			mergeDemand(reserved, demand);
			taken.push({ element, transition: owner.transition, demand });
		}
	}
	return taken;
}

function demandFor(state: IndexState, owner: TransitionIndex, element: BindingElement): Demand | undefined {
	const candidate = state.bindings.get(element.binding);
	if (candidate?.owner === owner) {
		return candidate.demand;
	}
	return bindingProblems(owner.transition, element.binding).length === 0
		? countsFor(owner.transition, element.binding)
		: undefined;
}

function fits(state: IndexState, reserved: Demand, demand: Demand): boolean {
	return [...demand].every(([place, counts]) =>
		[...counts].every(([key, need]) => countAt(state, place, key) - (reserved.get(place)?.get(key) ?? 0) >= need),
	);
}

function mergeDemand(total: Map<PlaceId, Map<string, number>>, demand: Demand): void {
	for (const [place, counts] of demand) {
		const combined = total.get(place) ?? new Map<string, number>();
		for (const [key, count] of counts) {
			combined.set(key, (combined.get(key) ?? 0) + count);
		}
		total.set(place, combined);
	}
}

function totalDemand(taken: readonly Allocation[]): Demand {
	const total = new Map<PlaceId, Map<string, number>>();
	for (const { demand } of taken) {
		mergeDemand(total, demand);
	}
	return total;
}

function removeDemand(state: IndexState, demand: Demand, changes: Changes): void {
	for (const [place, counts] of demand) {
		for (const [key, count] of counts) {
			removeCopies(state, place, key, count);
			changed(changes, place, key);
		}
		if (placeIn(state, place).tokens.size === 0 && state.placeOrder.delete(place)) {
			state.journal.push({ kind: "drop", place });
		}
	}
}

function removeCopies(state: IndexState, place: PlaceId, key: string, count: number): void {
	for (let copy = 0; copy < count; copy++) {
		const index = removeIndexed(placeIn(state, place), key);
		state.journal.push({ kind: "remove", place, index });
	}
}
