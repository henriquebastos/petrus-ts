import type { Marking } from "@petrus/petri-net";
import type { Ingress, LogEntry, NetInstanceState } from "./net-instance.ts";

/**
 * What a commit reads of a net instance: the marking, the length of the log, and only the log entries that it asks
 * for. A view of a stored instance reads one entry for each lookup, so the cost of a commit does not grow with the log.
 */
export type NetInstanceView = {
	/** The marking of the instance. */
	readonly marking: Marking;
	/** The number of entries in the log. The next entry gets this index. */
	readonly logLength: number;
	/** The ingress that the log holds under the request id, or undefined when the log has no such ingress. */
	readonly ingressOf: (requestId: string) => Ingress | undefined;
	/** The log entry at the index, or undefined when the log has no entry there. */
	readonly entryAt: (index: number) => LogEntry | undefined;
};

/** The view of a full state, for a caller that already holds the whole log. */
export function viewOf(state: NetInstanceState): NetInstanceView {
	return {
		marking: state.marking,
		logLength: state.log.length,
		ingressOf: (requestId) =>
			state.log.find((entry): entry is Ingress => entry.kind === "ingress" && entry.requestId === requestId),
		entryAt: (index) => state.log[index],
	};
}
