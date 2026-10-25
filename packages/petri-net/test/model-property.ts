import fc from "fast-check";
import type { Binding, Marking, PlaceId, Token, Transition } from "../src/index.ts";
import type { fire } from "../src/index.ts";
import type { Choice } from "./arbitraries.ts";
import {
	canonical,
	choiceArbitrary,
	chooseBinding,
	markingArbitrary,
	places,
	transitionArbitrary,
} from "./arbitraries.ts";

/** Any function with the shape of `fire`. Gate fixtures pass broken versions here. */
export type Fire = typeof fire;

/** The reference model: a mutable list of tokens per place, written in the plainest possible way. */
export type Model = { tokens: Map<PlaceId, Token[]> };

type Real = { marking: Marking };

/** The model's own read of a marking, kept apart from `tokensAt` so a bug there cannot agree with itself. */
export function ownTokens(marking: Marking, place: PlaceId): readonly Token[] {
	return new Map(Object.entries(marking)).get(place) ?? [];
}

function count(tokens: readonly Token[], token: Token): number {
	return tokens.filter((candidate) => canonical(candidate) === canonical(token)).length;
}

/** The tokens each input place must give, in arc order: a variable arc's values, or an expression arc's result. */
function modelDemand(transition: Transition, binding: Binding): ReadonlyMap<PlaceId, readonly Token[]> {
	const demand = new Map<PlaceId, Token[]>();
	for (const arc of transition.inputs) {
		const taken = demand.get(arc.place.id) ?? [];
		if (arc.variables !== undefined) {
			taken.push(...arc.variables.map((variable) => binding[variable] ?? null));
		} else {
			taken.push(...arc.expression(binding));
		}
		demand.set(arc.place.id, taken);
	}
	return demand;
}

/** A binding has a value in the variable's colour set for each variable and nothing else, and its guard holds. */
function modelIsBinding(transition: Transition, binding: Binding): boolean {
	const variables = Object.entries(transition.variables);
	const exactNames =
		Object.keys(binding).length === variables.length && variables.every(([name]) => Object.hasOwn(binding, name));
	return (
		exactNames &&
		variables.every(([name, colourSet]) => colourSet.contains(binding[name] ?? null)) &&
		transition.guard(binding)
	);
}

export function modelEnables(
	tokens: ReadonlyMap<PlaceId, readonly Token[]>,
	transition: Transition,
	binding: Binding,
): boolean {
	return (
		modelIsBinding(transition, binding) &&
		[...modelDemand(transition, binding)].every(([place, taken]) =>
			taken.every((token) => count(tokens.get(place) ?? [], token) >= count(taken, token)),
		)
	);
}

function modelFire(model: Model, transition: Transition, binding: Binding): void {
	modelTake(model, transition, binding);
	modelGive(model, transition, binding);
}

export function modelGive(model: Model, transition: Transition, binding: Binding): void {
	for (const arc of transition.outputs) {
		model.tokens.set(arc.place.id, [...(model.tokens.get(arc.place.id) ?? []), ...arc.expression(binding)]);
	}
}

export function modelTake(model: Model, transition: Transition, binding: Binding): void {
	for (const [place, taken] of modelDemand(transition, binding)) {
		const left = [...(model.tokens.get(place) ?? [])];
		for (const token of taken) {
			left.splice(
				left.findIndex((candidate) => canonical(candidate) === canonical(token)),
				1,
			);
		}
		model.tokens.set(place, left);
	}
}

function assertSameTokens(model: Model, marking: Marking): void {
	for (const place of places) {
		const actual = canonical(ownTokens(marking, place.id));
		const expected = canonical(model.tokens.get(place.id) ?? []);
		if (actual !== expected) {
			throw new Error(`place ${place.id}: fire gave ${actual}, the model gave ${expected}`);
		}
	}
	const listed = Object.entries(marking).filter(([, tokens]) => tokens.length > 0).length;
	if (listed !== Object.keys(marking).length) {
		throw new Error(`fire gave an empty place: ${JSON.stringify(marking)}`);
	}
}

class FireCommand implements fc.Command<Model, Real> {
	readonly #fire: Fire;
	readonly transition: Transition;
	readonly choice: Choice;
	binding: Binding = {};

	constructor(fireUnderTest: Fire, transition: Transition, choice: Choice) {
		this.#fire = fireUnderTest;
		this.transition = transition;
		this.choice = choice;
	}

	check(): boolean {
		return true;
	}

	run(model: Model, real: Real): void {
		this.binding = chooseBinding(this.transition, (place) => model.tokens.get(place) ?? [], this.choice);
		const enabled = modelEnables(model.tokens, this.transition, this.binding);
		const fired = this.#fire(this.transition, this.binding, real.marking);
		if (fired.ok !== enabled) {
			throw new Error(`fire said ok=${String(fired.ok)}, the model said enabled=${String(enabled)}`);
		}
		if (!fired.ok) {
			return;
		}
		modelFire(model, this.transition, this.binding);
		real.marking = fired.value;
		assertSameTokens(model, real.marking);
	}

	toString(): string {
		return `fire(${this.transition.id}, ${canonical(this.binding)})`;
	}
}

/** Any sequence of firings gives the same tokens, in the same order, as the reference model. */
export function modelProperty(fireUnderTest: Fire): fc.IProperty<[Marking, Iterable<fc.Command<Model, Real>>]> {
	const command = fc
		.tuple(transitionArbitrary, choiceArbitrary)
		.map(([transition, choice]) => new FireCommand(fireUnderTest, transition, choice));
	return fc.property(markingArbitrary, fc.commands([command], { maxCommands: 30 }), (initial, commands) => {
		const setup = (): { model: Model; real: Real } => ({
			model: { tokens: new Map(places.map((place) => [place.id, [...ownTokens(initial, place.id)]])) },
			real: { marking: initial },
		});
		fc.modelRun(setup, commands);
	});
}
