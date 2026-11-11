import type { Candidate, DomainValue, TransitionIndex } from "./candidate-binding.ts";
import { bindingFor, candidateFor, combinations, updateDomain } from "./candidate-binding.ts";
import type { PlaceId } from "./ids.ts";
import type { IndexState } from "./index-state.ts";
import { countAt, placeIn, watchersAt } from "./index-state.ts";
import { frontAt } from "./place-index.ts";

export type Changes = Map<PlaceId, Set<string>>;

export function changed(changes: Changes, place: PlaceId, key: string): void {
	const keys = changes.get(place) ?? new Set<string>();
	keys.add(key);
	changes.set(place, keys);
}

type Arrival = DomainValue & { readonly owner: TransitionIndex };

export function notify(state: IndexState, changes: Changes): void {
	const affected = new Set<Candidate>();
	const arrivals: Arrival[] = [];
	for (const [place, keys] of changes) {
		for (const key of keys) {
			collectChange(state, place, key, affected, arrivals);
		}
	}
	for (const candidate of affected) {
		refresh(state, candidate);
	}
	createArrivals(state, arrivals);
}

function createArrivals(state: IndexState, arrivals: readonly Arrival[]): void {
	for (const arrival of arrivals) {
		createCandidates(state, arrival.owner, arrival);
	}
}

function collectChange(
	state: IndexState,
	place: PlaceId,
	key: string,
	affected: Set<Candidate>,
	arrivals: Arrival[],
): void {
	collectWatchers(state, place, key, affected);
	for (const { owner, domain } of state.readers.get(place) ?? []) {
		if (updateDomain(domain, key, frontAt(placeIn(state, place), key))) {
			arrivals.push({ owner, domain, key });
		}
	}
}

function collectWatchers(state: IndexState, place: PlaceId, key: string, affected: Set<Candidate>): void {
	for (const candidate of state.watchers.get(place)?.get(key) ?? []) {
		affected.add(candidate);
	}
}

export function createCandidates(state: IndexState, owner: TransitionIndex, fixed: DomainValue | undefined): void {
	for (const keys of combinations(owner, fixed)) {
		const identity = JSON.stringify(keys);
		if (owner.candidates.has(identity)) {
			continue;
		}
		registerCandidate(state, owner, keys);
	}
}

function registerCandidate(state: IndexState, owner: TransitionIndex, keys: readonly string[]): void {
	const candidate = candidateFor(owner, keys);
	owner.candidates.set(JSON.stringify(keys), candidate);
	visitNeeds(candidate, (place, key) => {
		watchersAt(state, place, key).add(candidate);
	});
	refresh(state, candidate);
}

function visitNeeds(candidate: Candidate, visit: (place: PlaceId, key: string) => void): void {
	for (const [index, domain] of candidate.owner.domains.entries()) {
		// Stryker disable next-line StringLiteral: combinations emits one key per domain in declaration order.
		visit(domain.place, candidate.keys[index] ?? "");
	}
	visitDemand(candidate, visit);
}

function visitDemand(candidate: Candidate, visit: (place: PlaceId, key: string) => void): void {
	for (const [place, counts] of candidate.demand ?? []) {
		for (const key of counts.keys()) {
			visit(place, key);
		}
	}
}

function refresh(state: IndexState, candidate: Candidate): void {
	const owner = candidate.owner;
	owner.listed = undefined;
	owner.enabled.delete(candidate);
	// Stryker disable next-line StringLiteral: every candidate retains one key per domain, even after a value leaves.
	if (owner.domains.some((domain, index) => !domain.values.has(candidate.keys[index] ?? ""))) {
		forget(state, candidate);
		return;
	}
	if (representativesChanged(candidate)) {
		// updateDomain schedules every changed representative as an arrival before this refresh.
		forget(state, candidate);
		return;
	}
	if (ready(state, candidate)) {
		owner.enabled.add(candidate);
	}
}

function representativesChanged(candidate: Candidate): boolean {
	const binding = bindingFor(candidate.owner, candidate.keys);
	return candidate.owner.domains.some(({ variable }) => !Object.is(binding[variable], candidate.binding[variable]));
}

function ready(state: IndexState, candidate: Candidate): boolean {
	return (
		candidate.demand !== undefined &&
		[...candidate.demand].every(([place, counts]) =>
			[...counts].every(([key, need]) => countAt(state, place, key) >= need),
		)
	);
}

function forget(state: IndexState, candidate: Candidate): void {
	candidate.owner.candidates.delete(JSON.stringify(candidate.keys));
	// A caller can retain fired bindings after their tokens leave the marking.
	state.bindings.delete(candidate.binding);
	visitNeeds(candidate, (place, key) => {
		const candidates = watchersAt(state, place, key);
		candidates.delete(candidate);
		if (candidates.size === 0) {
			state.watchers.get(place)?.delete(key);
		}
	});
}
