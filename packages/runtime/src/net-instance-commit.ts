import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { Net, SelectionPolicy, TransitionId } from "@petrus/petri-net";
import { markingProblems } from "@petrus/petri-net";
import type { Admitted } from "./admit.ts";
import { advanceUntilQuiet } from "./advance.ts";
import type { NetInstanceRecord } from "./net-instance-record.ts";
import { netInstanceRecord, readNetInstance, writeNetInstance } from "./net-instance-record.ts";
import type { Ingress, NetInstanceState, Occurrence } from "./net-instance.ts";
import type { Operation } from "./operations.ts";
import { operationsStartedFrom } from "./operations.ts";

/**
 * Starts the work of one operation in the commit that started it: a Durable task in the instance's conversation.
 * `startedAt` is the time of that commit, which its occurrences share.
 */
export type StartOperation = (
	tx: Tx,
	conversationId: ConversationId,
	operation: Operation,
	startedAt: number,
) => Promise<unknown>;

/** What a commit of a net instance needs: the net's name, the plain net, its policy and handler transitions. */
export type NetInstanceParts = {
	readonly name: string;
	readonly net: Net;
	readonly policy: SelectionPolicy;
	readonly handlerIds: ReadonlySet<TransitionId>;
	readonly start: StartOperation;
};

/** What a commit did: the ingress of its change, and what its steps fired. A repeated change fires nothing. */
export type Committed = { readonly ingress: Ingress; readonly fired: readonly Occurrence[] };

/** A change of the instance: a host's batch or an operation's result, found from the state that the commit reads. */
export type Change = (state: NetInstanceState) => Admitted;

type Planned =
	| { readonly kind: "repeated"; readonly ingress: Ingress }
	| {
			readonly kind: "applied";
			readonly ingress: Ingress;
			readonly fired: readonly Occurrence[];
			readonly state: NetInstanceState;
			readonly started: readonly Operation[];
	  };

/**
 * The pure part of a commit: a new change, then steps until the net is quiet, and the operations that those steps
 * started. A repeated change plans nothing.
 */
export function plan(parts: NetInstanceParts, state: NetInstanceState, admitted: Admitted, at: number): Planned {
	if (admitted.kind === "repeated") {
		return admitted;
	}
	const stepped = advanceUntilQuiet(parts.net, parts.policy, admitted.state, at);
	const started = operationsStartedFrom(parts.handlerIds, stepped.state.log, state.log.length);
	return { kind: "applied", ingress: admitted.ingress, fired: stepped.fired, state: stepped.state, started };
}

/**
 * One commit of a net instance, inside a Durable transaction: it reads the instance, applies the change, steps until
 * the net is quiet, writes the marking and the new log entries, and starts a task for each operation that the steps
 * started. So the change, its firings and the start of their work land together or not at all.
 */
export async function commitToNetInstance(
	tx: Tx,
	conversationId: ConversationId,
	parts: NetInstanceParts,
	change: Change,
	at: number,
): Promise<Committed> {
	const draft = await tx.doc(netInstanceRecord, conversationId);
	const state = checkedState(parts, draft);
	const planned = plan(parts, state, change(state), at);
	if (planned.kind === "repeated") {
		return { ingress: planned.ingress, fired: [] };
	}
	writeNetInstance(draft, parts.name, state, planned.state);
	for (const operation of planned.started) {
		await parts.start(tx, conversationId, operation, at);
	}
	return { ingress: planned.ingress, fired: planned.fired };
}

/**
 * The state of a stored instance. An instance of another net, or a stored marking that does not fit the net (see
 * `markingProblems`), is a bug in the host or the store, so it throws.
 */
export function checkedState(parts: NetInstanceParts, stored: Readonly<NetInstanceRecord>): NetInstanceState {
	if (stored.net !== "" && stored.net !== parts.name) {
		throw new Error(`the conversation holds an instance of the net ${stored.net}, not ${parts.name}`);
	}
	const state = readNetInstance(stored);
	const wrong = markingProblems(parts.net, state.marking);
	if (wrong.length > 0) {
		throw new Error(`invalid stored marking: ${wrong.join("; ")}`);
	}
	return state;
}
