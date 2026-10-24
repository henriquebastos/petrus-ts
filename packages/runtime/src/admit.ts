import type { Marking, Net } from "@petrus/petri-net";
import { addTokens, markingProblems, placeId, tokenKey } from "@petrus/petri-net";
import type { Batch, Ingress, LogEntry, NetInstanceState } from "./net-instance.ts";

/**
 * `applied`: the batch is new, and `state` holds its tokens and its ingress. `repeated`: the log already has the
 * request id, so nothing changes and `ingress` is the recorded one.
 */
export type Admitted =
	| { readonly kind: "applied"; readonly ingress: Ingress; readonly state: NetInstanceState }
	| { readonly kind: "repeated"; readonly ingress: Ingress };

/**
 * The pure part of an enqueue. A batch that does not fit the net (see `markingProblems`) is a bug in the host, so
 * it throws, also when the log holds its request id; so does a request id that the log holds with other tokens.
 * The order of places does not count; the order of tokens on a place does.
 */
export function admit(net: Net, state: NetInstanceState, batch: Batch, at: number): Admitted {
	const problems = markingProblems(net, batch.tokens);
	if (problems.length > 0) {
		throw new Error(`invalid batch ${batch.requestId}: ${problems.join("; ")}`);
	}
	const recorded = recordedIngress(state.log, batch.requestId);
	if (recorded === undefined) {
		const ingress: Ingress = { kind: "ingress", requestId: batch.requestId, tokens: batch.tokens, at };
		return {
			kind: "applied",
			ingress,
			state: { marking: added(state.marking, batch.tokens), log: [...state.log, ingress] },
		};
	}
	if (tokenKey(recorded.tokens) !== tokenKey(batch.tokens)) {
		throw new Error(`request ${batch.requestId} already added other tokens`);
	}
	return { kind: "repeated", ingress: recorded };
}

function recordedIngress(log: readonly LogEntry[], requestId: string): Ingress | undefined {
	return log.find((entry): entry is Ingress => entry.kind === "ingress" && entry.requestId === requestId);
}

function added(marking: Marking, tokens: Marking): Marking {
	return Object.entries(tokens).reduce((sum, [place, more]) => addTokens(sum, placeId(place), more), marking);
}
