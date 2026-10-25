import type { JsonValue } from "@earendil-works/chord";
import type { ConversationDocToken, JsonObject } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
import type { Marking, Token } from "@petrus/petri-net";
import { placeId, transitionId } from "@petrus/petri-net";
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
 * commit. `ingresses` gives the log index of each ingress under the key `request:<request id>`, so a commit finds a
 * recorded request id by reading only that entry. The prefix keeps a request id such as `__proto__` from naming a
 * property that every object has.
 */
export type NetInstanceRecord = {
	net: string;
	marking: StoredMarking;
	log: StoredEntry[];
	ingresses: Record<string, number>;
};

/** Version 1 of the record had no index of the ingresses. */
type NetInstanceRecordVersion1 = Omit<NetInstanceRecord, "ingresses">;

/**
 * The Durable document of one net instance. It belongs to the instance's conversation and keeps only its latest
 * value: the log is the history. A fork of the conversation starts with no net instance.
 */
export const netInstanceRecord: ConversationDocToken<NetInstanceRecord> = defineDoc<NetInstanceRecord>({
	kind: "petrus.net-instance",
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ net: "", marking: {}, log: [], ingresses: {} }),
	migrate: (value) => withIngressIndex(value),
	checkpointWhen: () => false,
});

/**
 * A version 1 record with the index of its ingresses. A value that is not a version 1 record is a bug in the store,
 * so it throws.
 */
function withIngressIndex(value: JsonObject): NetInstanceRecord {
	if (!isVersion1(value)) {
		throw new BrokenNetInstance("a version 1 net instance record needs a net name, a marking and a log of entries");
	}
	const ingresses = Object.fromEntries(
		value.log.flatMap((entry, index): [string, number][] =>
			entry.kind === "ingress" ? [[indexKey(entry.requestId), index]] : [],
		),
	);
	return { net: value.net, marking: value.marking, log: value.log, ingresses };
}

function isVersion1(value: JsonObject): value is NetInstanceRecordVersion1 {
	const { net, marking, log } = value;
	return typeof net === "string" && isStoredMarking(marking) && Array.isArray(log) && log.every(isStoredEntry);
}

function isStoredEntry(entry: JsonValue): entry is StoredEntry {
	return isObject(entry) && typeof entry.at === "number" && (isStoredIngress(entry) || isStoredOccurrence(entry));
}

function isStoredIngress(entry: JsonObject): boolean {
	return entry.kind === "ingress" && typeof entry.requestId === "string" && isStoredMarking(entry.tokens);
}

function isStoredOccurrence(entry: JsonObject): boolean {
	return entry.kind === "occurrence" && typeof entry.transition === "string" && isObject(entry.binding);
}

function isStoredMarking(marking: JsonValue | undefined): marking is StoredMarking {
	return isObject(marking) && Object.values(marking).every((tokens) => Array.isArray(tokens));
}

function isObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
		marking: markingOf(stored.marking),
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
	const index = stored.ingresses[indexKey(requestId)];
	const entry = index === undefined ? undefined : stored.log[index];
	return entry?.kind === "ingress" && entry.requestId === requestId ? ingressOf(entry) : undefined;
}

function indexKey(requestId: string): string {
	return `request:${requestId}`;
}

/** Writes a commit into the draft: the marking, the new log entries `appended`, and the log index of each new ingress. */
export function writeNetInstance(
	draft: NetInstanceRecord,
	net: string,
	marking: Marking,
	appended: readonly LogEntry[],
): void {
	const first = draft.log.length;
	draft.net = net;
	draft.marking = storedMarking(marking);
	draft.log.push(...appended.map(storedEntry));
	appended.forEach((entry, index) => {
		if (entry.kind === "ingress") {
			draft.ingresses[indexKey(entry.requestId)] = first + index;
		}
	});
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
