import type { JsonValue } from "@earendil-works/chord";
import type { ConversationDocToken } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
import type { Marking, Token } from "@petrus/petri-net";
import { placeId, transitionId } from "@petrus/petri-net";
import type { LogEntry, NetInstanceState } from "./net-instance.ts";

type StoredMarking = Record<string, JsonValue[]>;

type StoredEntry =
	| { kind: "occurrence"; transition: string; binding: Record<string, JsonValue>; at: number }
	| { kind: "ingress"; requestId: string; tokens: StoredMarking; at: number };

/**
 * A net instance as Durable stores it. `net` names the net that owns the instance; it is empty until the first
 * commit.
 */
export type NetInstanceRecord = { net: string; marking: StoredMarking; log: StoredEntry[] };

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
	initial: () => ({ net: "", marking: {}, log: [] }),
	checkpointWhen: () => false,
});

/**
 * The state in a stored instance, as a copy. A commit reads its instance from a draft, whose values cannot be used
 * after the commit, so a recorded ingress that an enqueue returns must not point into it.
 */
export function readNetInstance(stored: Readonly<NetInstanceRecord>): NetInstanceState {
	return { marking: markingOf(stored.marking), log: stored.log.map(entryOf) };
}

/** Writes `after` into the draft of an instance whose state was `before`: the marking, and the new log entries. */
export function writeNetInstance(
	draft: NetInstanceRecord,
	net: string,
	before: NetInstanceState,
	after: NetInstanceState,
): void {
	draft.net = net;
	draft.marking = storedMarking(after.marking);
	draft.log.push(...after.log.slice(before.log.length).map(storedEntry));
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
		return { kind: "ingress", requestId: stored.requestId, tokens: markingOf(stored.tokens), at: stored.at };
	}
	return {
		kind: "occurrence",
		transition: transitionId(stored.transition),
		binding: jsonObject(stored.binding),
		at: stored.at,
	};
}
