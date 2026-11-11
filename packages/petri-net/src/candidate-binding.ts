import { bindingProblems } from "./binding.ts";
import { demandByPlace } from "./fire.ts";
import type { PlaceId } from "./ids.ts";
import type { Binding, Transition } from "./net.ts";
import type { PlaceIndex } from "./place-index.ts";
import { frontAt } from "./place-index.ts";
import type { BindingElement } from "./step.ts";
import type { Token } from "./token.ts";
import { countKeys, keyedTokens } from "./token.ts";

export type Domain = {
	readonly variable: string;
	readonly place: PlaceId;
	readonly values: Map<string, Token>;
	readonly buckets: Map<string, Set<string>>;
	readonly joins: Map<string, string>;
	readonly join: ((value: Token) => string) | undefined;
};

export type Candidate = {
	readonly owner: TransitionIndex;
	readonly keys: readonly string[];
	readonly binding: Binding;
	readonly demand: ReadonlyMap<PlaceId, ReadonlyMap<string, number>> | undefined;
};

export type TransitionIndex = {
	readonly transition: Transition;
	readonly domains: readonly Domain[];
	readonly candidates: Map<string, Candidate>;
	readonly enabled: Set<Candidate>;
	listed: readonly BindingElement[] | undefined;
};

export function transitionIndex(transition: Transition): TransitionIndex {
	return {
		transition,
		domains: Object.keys(transition.variables).map((variable) => domainOf(transition, variable)),
		candidates: new Map(),
		enabled: new Set(),
		listed: undefined,
	};
}

function domainOf(transition: Transition, variable: string): Domain {
	const arc = transition.inputs.find((input) => input.variables?.includes(variable) === true);
	if (arc === undefined) {
		throw new Error(`${transition.id}: variable ${variable} is on no variable input arc`);
	}
	return {
		variable,
		place: arc.place.id,
		values: new Map(),
		buckets: new Map(),
		joins: new Map(),
		join: Object.hasOwn(transition.joinKeys ?? {}, variable) ? transition.joinKeys?.[variable] : undefined,
	};
}

export function updateDomain(domain: Domain, key: string, front: readonly [number, Token] | undefined): boolean {
	const previous = domain.values.get(key);
	removeDomainValue(domain, key);
	if (front === undefined) {
		return false;
	}
	const [, token] = front;
	domain.values.set(key, token);
	if (domain.join !== undefined) {
		const join = domain.join(token);
		domain.joins.set(key, join);
		const bucket = domain.buckets.get(join) ?? new Set<string>();
		bucket.add(key);
		domain.buckets.set(join, bucket);
	}
	return !Object.is(previous, token);
}

function removeDomainValue(domain: Domain, key: string): void {
	domain.values.delete(key);
	const join = domain.joins.get(key);
	domain.joins.delete(key);
	if (join === undefined) {
		return;
	}
	const bucket = domain.buckets.get(join);
	if (bucket === undefined) {
		return;
	}
	bucket.delete(key);
	if (bucket.size === 0) {
		domain.buckets.delete(join);
	}
}

export type DomainValue = { readonly domain: Domain; readonly key: string };

/** Enumerates only combinations containing the fixed arrival, in domain order. */
export function combinations(owner: TransitionIndex, fixed: DomainValue | undefined): readonly (readonly string[])[] {
	const join = fixed?.domain.joins.get(fixed.key);
	return extend(owner.domains, fixed, [], join);
}

function extend(
	domains: readonly Domain[],
	fixed: DomainValue | undefined,
	keys: readonly string[],
	join: string | undefined,
): readonly (readonly string[])[] {
	const domain = domains[keys.length];
	if (domain === undefined) {
		return [keys];
	}
	const values = fixed?.domain === domain ? [fixed.key] : choices(domain, join);
	return values.flatMap((key) => {
		const nextJoin = join ?? domain.joins.get(key);
		return extend(domains, fixed, [...keys, key], nextJoin);
	});
}

function choices(domain: Domain, join: string | undefined): readonly string[] {
	if (domain.join !== undefined && join !== undefined) {
		return [...(domain.buckets.get(join) ?? [])];
	}
	return [...domain.values.keys()];
}

export function bindingFor(owner: TransitionIndex, keys: readonly string[]): Binding {
	return Object.fromEntries(
		// Stryker disable next-line StringLiteral: combinations emits one key per domain in declaration order.
		owner.domains.map((domain, index) => [domain.variable, domain.values.get(keys[index] ?? "") ?? null]),
	);
}

export function candidateFor(owner: TransitionIndex, keys: readonly string[]): Candidate {
	const binding = bindingFor(owner, keys);
	const demand =
		bindingProblems(owner.transition, binding).length === 0 ? countsFor(owner.transition, binding) : undefined;
	return { owner, keys, binding, demand };
}

export function countsFor(transition: Transition, binding: Binding): ReadonlyMap<PlaceId, ReadonlyMap<string, number>> {
	return new Map(
		[...demandByPlace(transition, binding)].map(([place, tokens]) => [place, countKeys(keyedTokens(tokens))]),
	);
}

export function compareCandidates(left: Candidate, right: Candidate, places: ReadonlyMap<PlaceId, PlaceIndex>): number {
	for (const [index, domain] of left.owner.domains.entries()) {
		// Stryker disable next-line StringLiteral: both candidates have one key per domain of the same transition.
		const difference = rank(places, domain, left.keys[index] ?? "") - rank(places, domain, right.keys[index] ?? "");
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
}

function rank(places: ReadonlyMap<PlaceId, PlaceIndex>, domain: Domain, key: string): number {
	const place = places.get(domain.place);
	return place === undefined ? 0 : (frontAt(place, key)?.[0] ?? 0);
}
