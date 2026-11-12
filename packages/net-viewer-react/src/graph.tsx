import type { ReactElement } from "react";
import type { Edge, Node, NodeProps } from "@xyflow/react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useNodesState } from "@xyflow/react";
import type { NetGraph, NetLayout, ViewFrame } from "@petrus/net-view-model";
import { viewTokens } from "@petrus/net-view-model";
import { ReplayEdge } from "./replay-edge.tsx";

type DisplayNode = Node<{ name: string; kind: string; count: number; enabled: boolean; active: boolean }, "petri">;

/** Node coordinates supplied by a host, independently of its layout engine. */
export type NodePositions = NetLayout["positions"];

const sides = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const;

/** Displays supplied counts and enablement. The browser never evaluates the net. */
function PetriNode({ data, selected }: NodeProps<DisplayNode>): ReactElement {
	return (
		<div
			className={`petri-node ${data.kind}`}
			data-selected={selected}
			data-active={data.active}
			data-enabled={data.enabled}
		>
			{sides.map((side) => (
				<Handle key={`in-${side}`} id={`in-${side}`} type="target" position={side} isConnectable={false} />
			))}
			<div className="shape">{data.kind === "place" ? data.count : ""}</div>
			<div className="node-name">{data.name}</div>
			{sides.map((side) => (
				<Handle key={`out-${side}`} id={`out-${side}`} type="source" position={side} isConnectable={false} />
			))}
		</div>
	);
}

const nodeTypes = { petri: PetriNode };
const edgeTypes = { replay: ReplayEdge };

function position(positions: NodePositions, id: string): { x: number; y: number } {
	const found = positions[id];
	if (found === undefined) throw new Error(`No layout for ${id}`);
	return found;
}

function arcHandles(
	positions: NodePositions,
	source: string,
	target: string,
): { sourceHandle: string; targetHandle: string } {
	const from = position(positions, source);
	const to = position(positions, target);
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	if (Math.abs(dx) > Math.abs(dy)) {
		return dx > 0
			? { sourceHandle: "out-right", targetHandle: "in-left" }
			: { sourceHandle: "out-left", targetHandle: "in-right" };
	}
	return dy > 0
		? { sourceHandle: "out-bottom", targetHandle: "in-top" }
		: { sourceHandle: "out-top", targetHandle: "in-bottom" };
}

/** A read-only canvas. Selection changes the inspector, not the net. */
export function NetCanvas({
	recording,
	frame,
	layout,
	pulse,
	selected,
	onSelect,
}: {
	readonly recording: NetGraph;
	readonly frame: ViewFrame;
	readonly layout: NetLayout;
	readonly pulse: number;
	readonly selected: string;
	readonly onSelect: (id: string) => void;
}): ReactElement {
	const { positions } = layout;
	// Keep React Flow's measured dimensions when replay changes the display data.
	const [measuredNodes, , onNodesChange] = useNodesState<DisplayNode>(
		recording.nodes.map((node) => ({
			id: node.id,
			type: "petri",
			position: position(positions, node.id),
			data: { name: node.name, kind: node.kind, count: 0, enabled: false, active: false },
		})),
	);
	const nodes: DisplayNode[] = measuredNodes.map((node) => ({
		...node,
		selected: selected === node.id,
		data: {
			...node.data,
			count: viewTokens(frame.marking, node.data.name).length,
			enabled: frame.enabled.some(({ transition }) => transition === node.data.name),
			active: frame.kind === "occurrence" && node.data.name === frame.label,
		},
	}));
	const transition = frame.kind === "occurrence" ? `transition:${frame.label}` : null;
	const edges: Edge[] = recording.arcs.map((arc) => {
		const highlighted = arc.source === selected || arc.target === selected;
		return {
			...arc,
			...arcHandles(positions, arc.source, arc.target),
			type: "replay",
			data: { pulse, transition, route: layout.routes[arc.id] ?? [], labelPosition: layout.labels[arc.id] },
			markerEnd: { type: MarkerType.ArrowClosed },
			label: highlighted ? arc.label : undefined,
			style: {
				stroke: highlighted ? "var(--selected-arc)" : "var(--arc)",
				strokeWidth: 1.6,
			},
		};
	});
	return (
		<ReactFlow
			colorMode="system"
			defaultMarkerColor="var(--arc)"
			nodes={nodes}
			onNodesChange={onNodesChange}
			edges={edges}
			nodeTypes={nodeTypes}
			edgeTypes={edgeTypes}
			fitView
			fitViewOptions={{ padding: 0.15 }}
			minZoom={0.05}
			maxZoom={2}
			nodesDraggable={false}
			nodesConnectable={false}
			deleteKeyCode={null}
			edgesFocusable={false}
			onNodeClick={(_event, node) => {
				onSelect(node.id);
			}}
			aria-label="Petri net"
		>
			<Background color="var(--grid)" gap={24} />
			<Controls showInteractive={false} />
		</ReactFlow>
	);
}
