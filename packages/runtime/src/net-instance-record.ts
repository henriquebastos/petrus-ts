import type { JsonValue } from "@earendil-works/chord";
import type { ConversationDocToken } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
import type { Marking, MarkingJournalOp, Token } from "@petrus/petri-net";
import { indexMarking, markingProblems, placeId, transitionId } from "@petrus/petri-net";
import type { IngressBuckets } from "./ingress-index.ts";
import { buildIngressIndex, ingressIndexOf, insertIngress } from "./ingress-index.ts";
import type { Ingress, LogEntry, NetInstanceState } from "./net-instance.ts";
import { BrokenNetInstance } from "./net-instance.ts";
import type { NetInstanceView } from "./net-instance-view.ts";

type StoredMarking = Record<string, JsonValue[]>;

type StoredIngress = { kind: "ingress"; requestId: string; tokens: StoredMarking; at: number };

type StoredEntry =
	| { kind: "occurrence"; transition: string; binding: Record<string, JsonValue>; at: number }
	| StoredIngress;

/**
 * A net instance as Durable stores it. `net` names the net that owns the instance; it is empty until the first
 * commit. `ingresses` stores sorted request id and log index pairs in 1024 array buckets.
 */
export type NetInstanceRecord = {
	net: string;
	stamp: string;
	marking: StoredMarking;
	log: StoredEntry[];
	ingresses: IngressBuckets;
};

/**
 * The Durable document of one net instance. It belongs to the instance's conversation and keeps only its latest
 * value: the log is the history. A fork of the conversation starts with no net instance.
 */
export const netInstanceRecord: ConversationDocToken<NetInstanceRecord> = defineDoc<NetInstanceRecord>({
	kind: "petrus.net-instance",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ net: "", stamp: "", marking: {}, log: [], ingresses: buildIngressIndex([]) }),
	checkpointWhen: () => false,
});

/**
 * The state in a stored instance, as a copy. A commit reads its instance from a draft, whose values cannot be used
 * after the commit, so a recorded ingress that an enqueue returns must not point into it.
 */
export function readNetInstance(stored: Readonly<NetInstanceRecord>): NetInstanceState {
	return { marking: markingOf(stored.marking), log: stored.log.map(entryOf) };
}

/**
 * The view of a stored instance, for a commit. It copies the marking, and only the log entries that the commit reads,
 * when it reads them: a draft's values cannot be used after the commit.
 */
export function readNetInstanceView(stored: Readonly<NetInstanceRecord>): NetInstanceView {
	return {
		indexed: (net) => {
			const marking = markingOf(stored.marking);
			const problems = markingProblems(net, marking);
			if (problems.length > 0) {
				throw new BrokenNetInstance(`invalid stored marking: ${problems.join("; ")}`);
			}
			return indexMarking(net, marking);
		},
		logLength: stored.log.length,
		ingressOf: (requestId) => recordedIngress(stored, requestId),
		entryAt: (index) => {
			const entry = stored.log[index];
			return entry === undefined ? undefined : entryOf(entry);
		},
	};
}

/** The ingress under `requestId`, from the index: only when the entry there is an ingress of that request id. */
function recordedIngress(stored: Readonly<NetInstanceRecord>, requestId: string): Ingress | undefined {
	const index = ingressIndexOf(stored.ingresses, requestId);
	const entry = index === undefined ? undefined : stored.log[index];
	return entry?.kind === "ingress" && entry.requestId === requestId ? ingressOf(entry) : undefined;
}

/** Replays changes on a Durable draft, then appends the log and indexes each new ingress. */
export function writeNetInstance(
	draft: NetInstanceRecord,
	net: string,
	journal: readonly MarkingJournalOp[],
	appended: readonly LogEntry[],
): void {
	const first = draft.log.length;
	draft.net = net;
	for (const op of journal) {
		replayMarking(draft.marking, op);
	}
	draft.log.push(...appended.map(storedEntry));
	appended.forEach((entry, index) => {
		if (entry.kind === "ingress") {
			insertIngress(draft.ingresses, entry.requestId, first + index);
		}
	});
}

function replayMarking(marking: StoredMarking, op: MarkingJournalOp): void {
	switch (op.kind) {
		case "drop":
			Reflect.deleteProperty(marking, op.place);
			break;
		case "remove":
			marking[op.place]?.splice(op.index, 1);
			break;
		case "append":
			appendStored(marking, op.place, op.tokens);
			break;
		// Stryker disable next-line ConditionalExpression: The journal union is exhaustive; this branch only checks its type.
		default:
			op satisfies never;
	}
}

function appendStored(marking: StoredMarking, place: string, tokens: readonly Token[]): void {
	const stored = tokens.map(json);
	if (Object.hasOwn(marking, place)) {
		marking[place]?.push(...stored);
	} else {
		marking[place] = stored;
	}
}

/** A copy of a token as Durable's JSON, whose lists are not read-only. */
export function json(token: Token): JsonValue {
	if (isList(token)) {
		return token.map(json);
	}
	return isRecord(token) ? jsonObject(token) : token;
}

function jsonObject(token: Readonly<Record<string, Token>>): Record<string, JsonValue> {
	return Object.fromEntries(Object.entries(token).map(([key, value]) => [key, json(value)]));
}

function isList(token: Token): token is readonly Token[] {
	return Array.isArray(token);
}

function isRecord(token: Token): token is Readonly<Record<string, Token>> {
	return typeof token === "object" && token !== null;
}

function storedMarking(marking: Marking): StoredMarking {
	return Object.fromEntries(Object.entries(marking).map(([place, tokens]) => [place, tokens.map(json)]));
}

function markingOf(stored: Readonly<StoredMarking>): Marking {
	return Object.fromEntries(Object.entries(stored).map(([place, tokens]) => [placeId(place), tokens.map(json)]));
}

function storedEntry(entry: LogEntry): StoredEntry {
	if (entry.kind === "ingress") {
		return { kind: "ingress", requestId: entry.requestId, tokens: storedMarking(entry.tokens), at: entry.at };
	}
	return { kind: "occurrence", transition: entry.transition, binding: jsonObject(entry.binding), at: entry.at };
}

function entryOf(stored: Readonly<StoredEntry>): LogEntry {
	if (stored.kind === "ingress") {
		return ingressOf(stored);
	}
	return {
		kind: "occurrence",
		transition: transitionId(stored.transition),
		binding: jsonObject(stored.binding),
		at: stored.at,
	};
}

function ingressOf(stored: Readonly<StoredIngress>): Ingress {
	return { kind: "ingress", requestId: stored.requestId, tokens: markingOf(stored.tokens), at: stored.at };
}
