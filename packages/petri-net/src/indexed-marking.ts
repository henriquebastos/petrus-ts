import { placeId } from "./ids.ts";
import type { PlaceId } from "./ids.ts";
import type { Changes } from "./index-notify.ts";
import { changed, createCandidates, notify } from "./index-notify.ts";
import type { IndexState } from "./index-state.ts";
import { indexState, placeIn } from "./index-state.ts";
import type { Marking } from "./marking.ts";
import type { MarkingJournalOp } from "./marking-journal.ts";
import type { Net } from "./net.ts";
import { appendIndexed } from "./place-index.ts";
import type { Token } from "./token.ts";

/** A linear owner of an indexed marking. Mutations consume it, including mutations that throw. */
export type IndexedMarking = { readonly journal: readonly MarkingJournalOp[] };

const owners = new WeakMap<IndexedMarking, IndexState>();

export function ownIndex(state: IndexState): IndexedMarking {
	const indexed: IndexedMarking = {
		get journal() {
			return readIndex(indexed).journal;
		},
	};
	owners.set(indexed, state);
	return indexed;
}

export function readIndex(indexed: IndexedMarking): IndexState {
	const state = owners.get(indexed);
	if (state === undefined) {
		throw new Error("the indexed marking is spent or is not an indexed owner");
	}
	return state;
}

export function consumeIndex(indexed: IndexedMarking): IndexState {
	const state = readIndex(indexed);
	owners.delete(indexed);
	return state;
}

/** Builds an index in stored arrival order. The initial journal is empty. The net and marking must be valid. */
export function indexMarking(net: Net, marking: Marking): IndexedMarking {
	const state = indexState(net);
	// Empty domains admit only variable-free candidates. Arrivals create the others after tokens are indexed.
	for (const owner of state.transitions) {
		createCandidates(state, owner, undefined);
	}
	const changes: Changes = new Map();
	for (const [place, tokens] of Object.entries(marking)) {
		appendToIndex(state, placeId(place), tokens, changes);
	}
	notify(state, changes);
	state.journal = [];
	return ownIndex(state);
}

/** Reads a marking in arrival order without consuming the owner. This operation costs all live tokens. */
export function markingOfIndexed(indexed: IndexedMarking): Marking {
	const state = readIndex(indexed);
	return Object.fromEntries(
		[...state.placeOrder].map((place) => [
			place,
			[...placeIn(state, place).tokens.values()].map(({ token }) => token),
		]),
	);
}

/** Appends tokens and returns the new owner. The old owner stays spent if a callback throws. */
export function addTokensIndexed(indexed: IndexedMarking, place: PlaceId, tokens: readonly Token[]): IndexedMarking {
	const state = consumeIndex(indexed);
	const changes: Changes = new Map();
	appendToIndex(state, place, tokens, changes);
	notify(state, changes);
	return ownIndex(state);
}

/** After persistence, consumes the owner and returns a new owner with an empty journal. */
export function clearJournalIndexed(indexed: IndexedMarking): IndexedMarking {
	const state = consumeIndex(indexed);
	state.journal = [];
	return ownIndex(state);
}

export function appendToIndex(state: IndexState, place: PlaceId, tokens: readonly Token[], changes: Changes): void {
	if (tokens.length === 0) {
		return;
	}
	const target = placeIn(state, place);
	state.placeOrder.add(place);
	for (const token of tokens) {
		changed(changes, place, appendIndexed(target, token));
	}
	state.journal.push({ kind: "append", place, tokens: [...tokens] });
}
