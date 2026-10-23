// Planted defect: a place with exactly the required tokens counts as short.
import type { Marking, NotEnabled, Result, Shortfall, Transition } from "../../packages/net/src/index.ts";
import { addTokens, err, ok, tokensAt } from "../../packages/net/src/index.ts";

export function fireOffByOne(transition: Transition, marking: Marking): Result<Marking, NotEnabled> {
	const missing: Shortfall[] = transition.inputs
		.map((arc) => ({ place: arc.place, required: arc.weight, available: tokensAt(marking, arc.place) }))
		.filter((shortfall) => shortfall.available <= shortfall.required);
	if (missing.length > 0) {
		return err({ kind: "not-enabled", transition: transition.id, shortfalls: missing });
	}
	const consumed = transition.inputs.reduce((next, arc) => addTokens(next, arc.place, -arc.weight), marking);
	return ok(transition.outputs.reduce((next, arc) => addTokens(next, arc.place, arc.weight), consumed));
}
