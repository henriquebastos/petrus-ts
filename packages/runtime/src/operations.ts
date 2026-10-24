import type { Binding, Net, TransitionId } from "@petrus/petri-net";
import { placeId } from "@petrus/petri-net";
import type { Admitted } from "./admit.ts";
import { admit, checkBatch, recordedIngress } from "./admit.ts";
import type { HandlerResult } from "./handlers.ts";
import { busyPlaceId, resultPlaceId, resultToken } from "./handlers.ts";
import type { Batch, LogEntry, NetInstanceState } from "./net-instance.ts";

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
	return log.flatMap((entry, index) =>
		entry.kind === "occurrence" && handlers.has(entry.transition)
			? [{ id: `${entry.transition}/${String(index)}`, transition: entry.transition, binding: entry.binding }]
			: [],
	);
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
	state: NetInstanceState,
	operationId: string,
	result: HandlerResult,
	at: number,
): Admitted {
	const operation = startedOperations(handlers, state.log).find((started) => started.id === operationId);
	if (operation === undefined) {
		throw new Error(`no operation ${operationId} has started`);
	}
	const batch = {
		requestId: resultRequestId(operationId),
		tokens: { [resultPlaceId(operation.transition)]: [resultToken(operation.binding, result)] },
	};
	checkBatch(net, batch);
	const recorded = recordedIngress(state.log, batch.requestId);
	return recorded === undefined ? admit(net, state, batch, at) : { kind: "repeated", ingress: recorded };
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
