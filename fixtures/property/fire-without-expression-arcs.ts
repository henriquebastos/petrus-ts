// Planted defect: the demand leaves out the expression input arcs, so fire neither checks nor takes their tokens.
import type {
	Binding,
	Marking,
	NotABinding,
	NotEnabled,
	PlaceId,
	Result,
	Token,
	Transition,
} from "../../packages/petri-net/src/index.ts";
import { addTokens, err, ok, removeTokens, tokensAt } from "../../packages/petri-net/src/index.ts";
import { bindingProblems } from "../../packages/petri-net/src/binding.ts";
import { takeTokens } from "../../packages/petri-net/src/token.ts";

export function fireWithoutExpressionArcs(
	transition: Transition,
	binding: Binding,
	marking: Marking,
): Result<Marking, NotABinding | NotEnabled> {
	const problems = bindingProblems(transition, binding);
	if (problems.length > 0) {
		return err({ kind: "not-a-binding", transition: transition.id, problems });
	}
	const demand = new Map<PlaceId, Token[]>();
	for (const arc of transition.inputs) {
		if (arc.variables !== undefined) {
			const taken = arc.variables.map((name) => binding[name] ?? null);
			demand.set(arc.place.id, [...(demand.get(arc.place.id) ?? []), ...taken]);
		}
	}
	const shortfalls = [...demand]
		.map(([place, wanted]) => ({ place, missing: takeTokens(tokensAt(marking, place), wanted).missing }))
		.filter((shortfall) => shortfall.missing.length > 0);
	if (shortfalls.length > 0) {
		return err({ kind: "not-enabled", transition: transition.id, shortfalls });
	}
	const consumed = [...demand].reduce((next, [place, wanted]) => removeTokens(next, place, wanted), marking);
	return ok(transition.outputs.reduce((next, arc) => addTokens(next, arc.place.id, arc.expression(binding)), consumed));
}
