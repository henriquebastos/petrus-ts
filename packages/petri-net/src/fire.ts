import type { PlaceId, TransitionId } from "./ids.ts";
import type { Marking } from "./marking.ts";
import { addTokens, tokensAt } from "./marking.ts";
import type { Result } from "./result.ts";
import { err, ok } from "./result.ts";
import type { Arc, Transition } from "./transition.ts";

/** One input place that holds fewer tokens than the transition consumes. */
export type Shortfall = { readonly place: PlaceId; readonly required: number; readonly available: number };

/** Why a transition did not fire: the input places that hold too few tokens. */
export type NotEnabled = {
	readonly kind: "not-enabled";
	readonly transition: TransitionId;
	readonly shortfalls: readonly Shortfall[];
};

/** Lists every input place that holds too few tokens. An empty list means the transition is enabled. */
export function shortfalls(transition: Transition, marking: Marking): readonly Shortfall[] {
	return [...demandByPlace(transition.inputs)]
		.map(([place, required]) => ({ place, required, available: tokensAt(marking, place) }))
		.filter((shortfall) => shortfall.available < shortfall.required);
}

/** True when every input place holds at least the tokens the transition consumes. */
export function isEnabled(transition: Transition, marking: Marking): boolean {
	return shortfalls(transition, marking).length === 0;
}

/** Consumes the input tokens and produces the output tokens, or reports why the transition is not enabled. */
export function fire(transition: Transition, marking: Marking): Result<Marking, NotEnabled> {
	const missing = shortfalls(transition, marking);
	if (missing.length > 0) {
		return err({ kind: "not-enabled", transition: transition.id, shortfalls: missing });
	}
	const consumed = transition.inputs.reduce((next, arc) => addTokens(next, arc.place, -arc.weight), marking);
	return ok(transition.outputs.reduce((next, arc) => addTokens(next, arc.place, arc.weight), consumed));
}

/** Two arcs from the same place add up, so the check sees the total demand. */
function demandByPlace(arcs: readonly Arc[]): ReadonlyMap<PlaceId, number> {
	const demand = new Map<PlaceId, number>();
	for (const arc of arcs) {
		demand.set(arc.place, (demand.get(arc.place) ?? 0) + arc.weight);
	}
	return demand;
}
