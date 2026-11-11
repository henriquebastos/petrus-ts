import type { Candidate, Domain, TransitionIndex } from "./candidate-binding.ts";
import { transitionIndex } from "./candidate-binding.ts";
import type { PlaceId } from "./ids.ts";
import type { MarkingJournalOp } from "./marking-journal.ts";
import type { Binding, Net } from "./net.ts";
import type { PlaceIndex } from "./place-index.ts";
import { emptyPlaceIndex } from "./place-index.ts";

export type IndexState = {
	readonly places: Map<PlaceId, PlaceIndex>;
	readonly placeOrder: Set<PlaceId>;
	readonly transitions: readonly TransitionIndex[];
	readonly readers: Map<PlaceId, { readonly owner: TransitionIndex; readonly domain: Domain }[]>;
	readonly watchers: Map<PlaceId, Map<string, Set<Candidate>>>;
	readonly bindings: WeakMap<Binding, Candidate>;
	journal: MarkingJournalOp[];
};

export function indexState(net: Net): IndexState {
	const transitions = net.transitions.map(transitionIndex);
	const state: IndexState = {
		places: new Map(),
		placeOrder: new Set(),
		transitions,
		readers: new Map(),
		watchers: new Map(),
		bindings: new WeakMap(),
		journal: [],
	};
	for (const owner of transitions) {
		for (const domain of owner.domains) {
			const readers = state.readers.get(domain.place) ?? [];
			readers.push({ owner, domain });
			state.readers.set(domain.place, readers);
		}
	}
	return state;
}

export function placeIn(state: IndexState, place: PlaceId): PlaceIndex {
	const indexed = state.places.get(place) ?? emptyPlaceIndex();
	state.places.set(place, indexed);
	return indexed;
}

export function countAt(state: IndexState, place: PlaceId, key: string): number {
	return state.places.get(place)?.copies.get(key)?.size ?? 0;
}

export function watchersAt(state: IndexState, place: PlaceId, key: string): Set<Candidate> {
	const watchers = state.watchers.get(place) ?? new Map<string, Set<Candidate>>();
	state.watchers.set(place, watchers);
	const candidates = watchers.get(key) ?? new Set<Candidate>();
	watchers.set(key, candidates);
	return candidates;
}
