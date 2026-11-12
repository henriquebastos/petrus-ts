import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkLabel } from "elkjs/lib/elk.bundled.js";
import type { NetGraph, NetLayout, Point } from "@petrus/net-view-model";

function labelCenter(label: ElkLabel): Point {
	return { x: (label.x ?? 0) + (label.width ?? 0) / 2, y: (label.y ?? 0) + (label.height ?? 0) / 2 };
}

/** Uses ELK's layered layout for branches, cycles, and disconnected components. */
export async function layoutNet(graph: NetGraph): Promise<NetLayout> {
	const elk = new ELK.default();
	const laidOut = await elk.layout({
		id: "net",
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.direction": "RIGHT",
			"elk.spacing.nodeNode": "60",
			"elk.layered.spacing.nodeNodeBetweenLayers": "60",
			"elk.nodeLabels.placement": "OUTSIDE V_BOTTOM H_CENTER",
			"elk.randomSeed": "1",
		},
		children: graph.nodes.map(({ id, name, kind }) => ({
			id,
			width: kind === "transition" ? 16 : 44,
			height: 44,
			labels: [{ text: name, width: name.length * 8 + 8, height: 22 }],
		})),
		edges: graph.arcs.map(
			({ id, source, target, label }): ElkExtendedEdge => ({
				id,
				sources: [source],
				targets: [target],
				labels: [{ text: label, width: label.length * 6, height: 16 }],
			}),
		),
	});
	return {
		labels: Object.fromEntries(
			laidOut.edges.flatMap((edge) => (edge.labels ?? []).map((label) => [edge.id, labelCenter(label)])),
		),
		positions: Object.fromEntries(
			(laidOut.children ?? []).map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]),
		),
		routes: Object.fromEntries(
			laidOut.edges.map((edge) => [
				edge.id,
				(edge.sections ?? []).flatMap((section) => [
					section.startPoint,
					...(section.bendPoints ?? []),
					section.endPoint,
				]),
			]),
		),
	};
}
