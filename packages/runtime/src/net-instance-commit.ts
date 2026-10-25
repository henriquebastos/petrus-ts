import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { Marking, Net, SelectionPolicy, TransitionId } from "@petrus/petri-net";
import { markingProblems } from "@petrus/petri-net";
import type { Admitted } from "./admit.ts";
import { advanceUntilQuiet } from "./advance.ts";
import type { NetInstanceRecord } from "./net-instance-record.ts";
import { netInstanceRecord, readNetInstance, readNetInstanceView, writeNetInstance } from "./net-instance-record.ts";
import type { Ingress, LogEntry, NetInstanceState, Occurrence } from "./net-instance.ts";
import { BrokenNetInstance } from "./net-instance.ts";
import type { NetInstanceView } from "./net-instance-view.ts";
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

/** A change of the instance: a host's batch or an operation's result, found from the view that the commit reads. */
export type Change = (view: NetInstanceView) => Admitted;

type Planned =
	| { readonly kind: "repeated"; readonly ingress: Ingress }
	| {
			readonly kind: "applied";
			readonly ingress: Ingress;
			readonly fired: readonly Occurrence[];
			readonly marking: Marking;
			readonly appended: readonly LogEntry[];
			readonly started: readonly Operation[];
	  };

/**
 * The pure part of a commit: a new change, then steps until the net is quiet, the log entries to append (the
 * change's ingress, then the occurrences), and the operations that those steps started. A repeated change plans
 * nothing.
 */
export function plan(parts: NetInstanceParts, view: NetInstanceView, admitted: Admitted, at: number): Planned {
	if (admitted.kind === "repeated") {
		return admitted;
	}
	const stepped = advanceUntilQuiet(parts.net, parts.policy, admitted.marking, at);
	const appended = [admitted.ingress, ...stepped.fired];
	const started = operationsStartedFrom(parts.handlerIds, appended, view.logLength);
	return {
		kind: "applied",
		ingress: admitted.ingress,
		fired: stepped.fired,
		marking: stepped.marking,
		appended,
		started,
	};
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
	const planned = commitToRecord(parts, draft, change, at);
	if (planned.kind === "repeated") {
		return { ingress: planned.ingress, fired: [] };
	}
	for (const operation of planned.started) {
		await parts.start(tx, conversationId, operation, at);
	}
	return { ingress: planned.ingress, fired: planned.fired };
}

/**
 * The part of a commit on the stored instance: it reads a checked view, plans the change, and writes an applied
 * change. It reads the marking, the length of the log, and only the log entries that the change asks for.
 */
export function commitToRecord(parts: NetInstanceParts, draft: NetInstanceRecord, change: Change, at: number): Planned {
	const view = checked(parts, draft, readNetInstanceView);
	const planned = plan(parts, view, change(view), at);
	if (planned.kind === "applied") {
		writeNetInstance(draft, parts.name, planned.marking, planned.appended);
	}
	return planned;
}

/**
 * The state of a stored instance. An instance of another net, or a stored marking that does not fit the net (see
 * `markingProblems`), is a bug in the host or the store, so it throws.
 */
export function checkedState(parts: NetInstanceParts, stored: Readonly<NetInstanceRecord>): NetInstanceState {
	return checked(parts, stored, readNetInstance);
}

function checked<Read extends { readonly marking: Marking }>(
	parts: NetInstanceParts,
	stored: Readonly<NetInstanceRecord>,
	read: (stored: Readonly<NetInstanceRecord>) => Read,
): Read {
	if (stored.net !== "" && stored.net !== parts.name) {
		throw new BrokenNetInstance(`the conversation holds an instance of the net ${stored.net}, not ${parts.name}`);
	}
	const copy = read(stored);
	const wrong = markingProblems(parts.net, copy.marking);
	if (wrong.length > 0) {
		throw new BrokenNetInstance(`invalid stored marking: ${wrong.join("; ")}`);
	}
	return copy;
}
