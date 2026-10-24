import fc from "fast-check";
import type { Marking, PlaceId, Transition } from "../src/index.ts";
import type { fire } from "../src/index.ts";
import { markingArbitrary, places, transitionArbitrary } from "./arbitraries.ts";

/** Any function with the shape of `fire`. Gate fixtures pass broken versions here. */
export type Fire = typeof fire;

/** The reference model: a mutable count per place, written in the plainest possible way. */
type Model = { counts: Map<PlaceId, number> };

type Real = { marking: Marking };

/** The model's own read of a marking, kept apart from `tokensAt` so a bug there cannot agree with itself. */
function ownCount(marking: Marking, place: PlaceId): number {
	return new Map(Object.entries(marking)).get(place) ?? 0;
}

function modelEnables(model: Model, transition: Transition): boolean {
	return transition.inputs.every((arc) => {
		const required = transition.inputs
			.filter((other) => other.place === arc.place)
			.reduce((sum, other) => sum + other.weight, 0);
		return (model.counts.get(arc.place) ?? 0) >= required;
	});
}

function modelFire(model: Model, transition: Transition): void {
	for (const arc of transition.inputs) {
		model.counts.set(arc.place, (model.counts.get(arc.place) ?? 0) - arc.weight);
	}
	for (const arc of transition.outputs) {
		model.counts.set(arc.place, (model.counts.get(arc.place) ?? 0) + arc.weight);
	}
}

function assertSameCounts(model: Model, marking: Marking): void {
	for (const place of places) {
		const actual = ownCount(marking, place);
		const expected = model.counts.get(place) ?? 0;
		if (actual !== expected) {
			throw new Error(`place ${place}: fire gave ${String(actual)}, the model gave ${String(expected)}`);
		}
	}
}

class FireCommand implements fc.Command<Model, Real> {
	readonly #fire: Fire;
	readonly transition: Transition;

	constructor(fireUnderTest: Fire, transition: Transition) {
		this.#fire = fireUnderTest;
		this.transition = transition;
	}

	check(): boolean {
		return true;
	}

	run(model: Model, real: Real): void {
		const enabled = modelEnables(model, this.transition);
		const fired = this.#fire(this.transition, real.marking);
		if (fired.ok !== enabled) {
			throw new Error(`fire said ok=${String(fired.ok)}, the model said enabled=${String(enabled)}`);
		}
		if (!fired.ok) {
			return;
		}
		modelFire(model, this.transition);
		real.marking = fired.value;
		assertSameCounts(model, real.marking);
	}

	toString(): string {
		return `fire(${this.transition.id})`;
	}
}

/** Any sequence of firings gives the same counts as the reference model. */
export function modelProperty(fireUnderTest: Fire): fc.IProperty<[Marking, Iterable<fc.Command<Model, Real>>]> {
	const command = transitionArbitrary.map((transition) => new FireCommand(fireUnderTest, transition));
	return fc.property(markingArbitrary, fc.commands([command], { maxCommands: 30 }), (initial, commands) => {
		const setup = (): { model: Model; real: Real } => ({
			model: { counts: new Map(places.map((place) => [place, ownCount(initial, place)])) },
			real: { marking: initial },
		});
		fc.modelRun(setup, commands);
	});
}
