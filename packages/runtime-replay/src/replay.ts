import type { Marking, Net } from "@petrus/petri-net";
import { addTokens, fire, placeId } from "@petrus/petri-net";
import type { LogEntry } from "@petrus/runtime";
import type { ViewFrame } from "@petrus/net-view-model";
import { inspectMarking } from "@petrus/net-view-model";

/** Replays the runtime log with Petrus. Intermediate frames are not committed snapshots. */
export function replay(net: Net, log: readonly LogEntry[]): readonly ViewFrame[] {
	let marking: Marking = {};
	const frames: ViewFrame[] = [inspectMarking(net, marking)];
	for (const entry of log) {
		marking = applyEntry(net, marking, entry);
		frames.push({
			...inspectMarking(net, marking),
			kind: entry.kind,
			label: entry.kind === "ingress" ? entry.requestId : entry.transition,
			at: entry.at,
			binding: entry.kind === "occurrence" ? entry.binding : {},
		});
	}
	return frames;
}

function applyEntry(net: Net, marking: Marking, entry: LogEntry): Marking {
	if (entry.kind === "ingress") {
		return Object.entries(entry.tokens).reduce((next, [id, tokens]) => addTokens(next, placeId(id), tokens), marking);
	}
	const transition = net.transitions.find(({ id }) => id === entry.transition);
	if (transition === undefined) throw new Error(`Unknown transition: ${entry.transition}`);
	const result = fire(transition, entry.binding, marking);
	if (!result.ok) throw new Error(`Cannot replay ${entry.transition}: ${JSON.stringify(result.error)}`);
	return result.value;
}
