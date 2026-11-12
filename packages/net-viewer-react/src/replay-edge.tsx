import type { ReactElement } from "react";
import type { Edge, EdgeProps } from "@xyflow/react";
import { BaseEdge, getBezierPath } from "@xyflow/react";
import type { Point } from "@petrus/net-view-model";

type ArcData = {
	readonly pulse: number;
	readonly transition: string | null;
	readonly route: readonly Point[];
	readonly labelPosition?: Point | undefined;
};
type ReplayArc = Edge<ArcData> & { readonly data: ArcData };

function Travel({ path, source, target, data }: EdgeProps<ReplayArc> & { readonly path: string }): ReactElement | null {
	if (data.pulse === 0) return null;
	const role = target === data.transition ? "input" : source === data.transition ? "output" : null;
	if (role === null) return null;
	return (
		<circle
			key={data.pulse}
			className="travel-token"
			data-role={role}
			r={5}
			style={{ offsetPath: `path("${path}")` }}
		/>
	);
}

function routePath(props: EdgeProps<ReplayArc>): readonly [string, number, number] {
	const route = props.data.route;
	const start = route[0];
	const end = route[1];
	if (start === undefined || end === undefined) {
		const [path, x, y] = getBezierPath(props);
		return [path, x, y];
	}
	return [
		route.map(({ x, y }, i) => `${i === 0 ? "M" : "L"} ${String(x)} ${String(y)}`).join(" "),
		(start.x + end.x) / 2,
		(start.y + end.y) / 2 + 14,
	];
}

/** Token travel illustrates adjacent forward replay, never reverse execution. */
export function ReplayEdge(props: EdgeProps<ReplayArc>): ReactElement {
	const [path, labelX, labelY] = routePath(props);
	const label = props.data.labelPosition ?? { x: labelX, y: labelY };
	return (
		<>
			<BaseEdge
				path={path}
				markerEnd={props.markerEnd ?? ""}
				style={props.style}
				label={props.label}
				labelX={label.x}
				labelY={label.y}
			/>
			<Travel {...props} path={path} />
		</>
	);
}
