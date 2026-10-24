import type { Marking, Net } from "@petrus/petri-net";
import { addTokens, fire, placeId } from "@petrus/petri-net";
import type { LogEntry } from "../src/index.ts";

/** The marking with every token of `tokens` added, place by place. */
export function withAdded(marking: Marking, tokens: Marking): Marking {
	return Object.entries(tokens).reduce((sum, [place, more]) => addTokens(sum, placeId(place), more), marking);
}

/** Replays the log on `net` one entry at a time, from `first`. `undefined` when an occurrence cannot fire. */
export function replay(net: Net, first: Marking, log: readonly LogEntry[]): Marking | undefined {
	return log.reduce<Marking | undefined>(
		(marking, entry) => (marking === undefined ? undefined : replayEntry(net, marking, entry)),
		first,
	);
}

function replayEntry(net: Net, marking: Marking, entry: LogEntry): Marking | undefined {
	if (entry.kind === "ingress") {
		return withAdded(marking, entry.tokens);
	}
	const transition = net.transitions.find((candidate) => candidate.id === entry.transition);
	const fired = transition === undefined ? undefined : fire(transition, entry.binding, marking);
	return fired?.ok === true ? fired.value : undefined;
}

/** Equal markings: the same places with the same token lists. The order of places in the object does not count. */
export function sameMarking(left: Marking | undefined, right: Marking): boolean {
	const sorted = (marking: Marking): string =>
		JSON.stringify(Object.entries(marking).sort(([a], [b]) => a.localeCompare(b)));
	return left !== undefined && sorted(left) === sorted(right);
}
