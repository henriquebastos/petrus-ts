import type { IndexedMarking, Marking, Net } from "@petrus/petri-net";
import { addTokensIndexed, markingProblems, placeId, tokenKey } from "@petrus/petri-net";
import type { Batch, Ingress } from "./net-instance.ts";
import type { NetInstanceView } from "./net-instance-view.ts";

/**
 * `applied`: the batch is new; `ingress` is its new log entry, and `indexed` holds its tokens. `repeated`: the log
 * already has the request id, so nothing changes and `ingress` is the recorded one.
 */
export type Admitted =
	| { readonly kind: "applied"; readonly ingress: Ingress; readonly indexed: IndexedMarking }
	| { readonly kind: "repeated"; readonly ingress: Ingress };

/**
 * The pure part of an enqueue. A batch that does not fit the net (see `markingProblems`) is a bug in the host, so
 * it throws, also when the log holds its request id; so does a request id that the log holds with other tokens.
 * The order of places does not count; the order of tokens on a place does.
 */
export function admit(net: Net, view: NetInstanceView, batch: Batch, at: number): Admitted {
	checkBatch(net, batch);
	const recorded = view.ingressOf(batch.requestId);
	if (recorded === undefined) {
		const ingress: Ingress = { kind: "ingress", requestId: batch.requestId, tokens: batch.tokens, at };
		return { kind: "applied", ingress, indexed: added(view.indexed(net), batch.tokens) };
	}
	if (tokenKey(recorded.tokens) !== tokenKey(batch.tokens)) {
		throw new Error(`request ${batch.requestId} already added other tokens`);
	}
	return { kind: "repeated", ingress: recorded };
}

/** Throws when the batch does not fit the net (see `markingProblems`), and names every problem. */
export function checkBatch(net: Net, batch: Batch): void {
	const problems = markingProblems(net, batch.tokens);
	if (problems.length > 0) {
		throw new Error(`invalid batch ${batch.requestId}: ${problems.join("; ")}`);
	}
}

function added(indexed: IndexedMarking, tokens: Marking): IndexedMarking {
	return Object.entries(tokens).reduce((sum, [place, more]) => addTokensIndexed(sum, placeId(place), more), indexed);
}
