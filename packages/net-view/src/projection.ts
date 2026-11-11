import type { Marking, Net } from "@petrus/petri-net";
import { enabledElements } from "@petrus/petri-net";
import type { NetGraph, ViewFrame } from "./model.ts";

/** Projects topology without serializing guards or merging parallel arcs. */
export function projectNet(net: Net): NetGraph {
	return {
		nodes: [
			...net.places.map(({ id, colourSet }) => ({
				id: `place:${id}`,
				kind: "place" as const,
				name: id,
				detail: colourSet.name,
			})),
			...net.transitions.map(({ id, variables }) => ({
				id: `transition:${id}`,
				kind: "transition" as const,
				name: id,
				detail: Object.keys(variables).join(", "),
			})),
		],
		arcs: net.transitions.flatMap((transition) => [
			...transition.inputs.map((arc, index) => ({
				id: `${transition.id}:input:${String(index)}`,
				source: `place:${arc.place.id}`,
				target: `transition:${transition.id}`,
				label: arc.variables?.join(", ") ?? "expression",
			})),
			...transition.outputs.map((arc, index) => ({
				id: `${transition.id}:output:${String(index)}`,
				source: `transition:${transition.id}`,
				target: `place:${arc.place.id}`,
				label: "expression",
			})),
		]),
	};
}

/** Inspects a marking through Petrus. It does not fire any transition. */
export function inspectMarking(net: Net, marking: Marking): ViewFrame {
	return {
		kind: "initial",
		label: "Initial marking",
		at: null,
		binding: {},
		marking,
		enabled: [...enabledElements(net, marking)],
	};
}
