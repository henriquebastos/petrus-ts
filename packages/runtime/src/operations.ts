import type { Binding, Net, TransitionId } from "@petrus/petri-net";
import { placeId } from "@petrus/petri-net";
import type { Admitted } from "./admit.ts";
import { admit, checkBatch } from "./admit.ts";
import type { HandlerResult } from "./handlers.ts";
import { busyPlaceId, resultPlaceId, resultToken } from "./handlers.ts";
import type { Batch, LogEntry, Occurrence } from "./net-instance.ts";
import { BrokenNetInstance } from "./net-instance.ts";
import type { NetInstanceView } from "./net-instance-view.ts";

/**
 * The work that one occurrence of a handler transition started. Its id is the transition and the position of the
 * occurrence in the log, so it stays the same after a restart. A handler gives it to the outside service, so that a
 * second run of the same work can find what the first run did.
 */
export type Operation = { readonly id: string; readonly transition: TransitionId; readonly binding: Binding };

const resultPrefix = "result:";

/** The request id of an operation's result. A host's request id must not start with `result:`. */
function resultRequestId(operationId: string): string {
	return `${resultPrefix}${operationId}`;
}

/** Every operation that the log started, in log order. `handlers` names the handler transitions. */
export function startedOperations(handlers: ReadonlySet<TransitionId>, log: readonly LogEntry[]): readonly Operation[] {
	return operationsStartedFrom(handlers, log, 0);
}

/**
 * The operations that new log entries started: the work that the commit of those entries begins. `firstIndex` is
 * the log index of the first entry, so the entry at position `i` has the index `firstIndex + i`.
 */
export function operationsStartedFrom(
	handlers: ReadonlySet<TransitionId>,
	entries: readonly LogEntry[],
	firstIndex: number,
): readonly Operation[] {
	return entries.flatMap((entry, i) =>
		entry.kind === "occurrence" && handlers.has(entry.transition) ? [operationAt(entry, firstIndex + i)] : [],
	);
}

/**
 * The operation `operationId`, found from its log index in `t/<index>`: only when the entry there is an occurrence
 * of the handler transition `t`. Otherwise no such operation has started.
 */
export function startedOperation(
	handlers: ReadonlySet<TransitionId>,
	view: NetInstanceView,
	operationId: string,
): Operation | undefined {
	const index = Number(operationId.slice(operationId.lastIndexOf("/") + 1));
	const entry = view.entryAt(index);
	if (entry?.kind !== "occurrence" || !handlers.has(entry.transition)) {
		return undefined;
	}
	const operation = operationAt(entry, index);
	return operation.id === operationId ? operation : undefined;
}

function operationAt(occurrence: Occurrence, index: number): Operation {
	return {
		id: `${occurrence.transition}/${String(index)}`,
		transition: occurrence.transition,
		binding: occurrence.binding,
	};
}

/** The started operations whose result the log does not hold: work that runs now, or must run again after a restart. */
export function operationsInFlight(
	handlers: ReadonlySet<TransitionId>,
	log: readonly LogEntry[],
): readonly Operation[] {
	const recorded = new Set<string>();
	for (const entry of log) {
		if (entry.kind === "ingress") {
			recorded.add(entry.requestId);
		}
	}
	return startedOperations(handlers, log).filter((operation) => !recorded.has(resultRequestId(operation.id)));
}

/**
 * The pure part of completing an operation: its result token goes on the handler transition's result place, under
 * the request id `result:<operation id>`. The first result counts: a later one, as from a second run after a
 * restart, returns the recorded ingress and changes nothing. An id that names no started operation, or a result
 * that does not fit the transition (a variant it does not declare, a value outside the variant's colour set), is a
 * bug, so it throws, also when the log holds a result for the operation.
 */
export function admitResult(
	net: Net,
	handlers: ReadonlySet<TransitionId>,
	view: NetInstanceView,
	operationId: string,
	result: HandlerResult,
	at: number,
): Admitted {
	const operation = startedOperation(handlers, view, operationId);
	if (operation === undefined) {
		throw new BrokenNetInstance(`no operation ${operationId} has started`);
	}
	const batch = checkedResultBatch(net, operation, result);
	const recorded = view.ingressOf(batch.requestId);
	return recorded === undefined ? admit(net, view, batch, at) : { kind: "repeated", ingress: recorded };
}

/**
 * The batch that puts an operation's result on its result place, under the request id `result:<operation id>`. A
 * result that does not fit the transition is a bug, so it throws.
 */
export function checkedResultBatch(net: Net, operation: Operation, result: HandlerResult): Batch {
	const batch = {
		requestId: resultRequestId(operation.id),
		tokens: { [resultPlaceId(operation.transition)]: [resultToken(operation.binding, result)] },
	};
	checkBatch(net, batch);
	return batch;
}

/**
 * Why a host's batch would break the handlers: a request id that starts with `result:`, or tokens on a busy or
 * result place, which only the runtime fills. An empty list means the batch is the host's to add.
 */
export function hostBatchProblems(handlers: ReadonlySet<TransitionId>, batch: Batch): readonly string[] {
	const owned = new Set([...handlers].flatMap((handler) => [busyPlaceId(handler), resultPlaceId(handler)]));
	const reserved = batch.requestId.startsWith(resultPrefix)
		? [`the request id starts with "${resultPrefix}", which the runtime keeps for handler results`]
		: [];
	const places = Object.keys(batch.tokens)
		.filter((place) => owned.has(placeId(place)))
		.map((place) => `place ${place} is filled only by the runtime`);
	return [...reserved, ...places];
}
