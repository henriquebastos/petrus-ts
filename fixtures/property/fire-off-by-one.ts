// Planted defect: a place with exactly the tokens the binding takes counts as short.
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
import { canonical } from "../../packages/petri-net/test/arbitraries.ts";

function count(tokens: readonly Token[], token: Token): number {
	return tokens.filter((candidate) => canonical(candidate) === canonical(token)).length;
}

export function fireOffByOne(
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
		demand.set(arc.place.id, [...(demand.get(arc.place.id) ?? []), ...arc.variables.map((name) => binding[name] ?? null)]);
	}
	const shortfalls = [...demand]
		.filter(([place, wanted]) => wanted.some((token) => count(tokensAt(marking, place), token) <= count(wanted, token)))
		.map(([place, wanted]) => ({ place, missing: wanted }));
	if (shortfalls.length > 0) {
		return err({ kind: "not-enabled", transition: transition.id, shortfalls });
	}
	const consumed = [...demand].reduce((next, [place, wanted]) => removeTokens(next, place, wanted), marking);
	return ok(transition.outputs.reduce((next, arc) => addTokens(next, arc.place.id, arc.expression(binding)), consumed));
}
