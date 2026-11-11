// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { ReactFlowProvider, Position } from "@xyflow/react";
import { afterEach, expect, test } from "vitest";
import { ReplayEdge } from "../src/replay-edge.tsx";

afterEach(cleanup);

test.each([
	{ source: "place:a", target: "transition:b", pulse: 1, role: "input" },
	{ source: "transition:b", target: "place:a", pulse: 2, role: "output" },
	{ source: "place:c", target: "transition:d", pulse: 1, role: null },
	{ source: "place:a", target: "transition:b", pulse: 0, role: null },
])(
	"routes an arc and shows forward travel only on adjacent arcs: $source to $target, pulse $pulse",
	({ source, target, pulse, role }) => {
		const { container, rerender } = render(
			<ReactFlowProvider>
				<svg>
					<ReplayEdge
						id="arc"
						source={source}
						target={target}
						sourceX={10}
						sourceY={20}
						targetX={170}
						targetY={80}
						sourcePosition={Position.Right}
						targetPosition={Position.Left}
						data={{
							pulse,
							transition: "transition:b",
							route: [
								{ x: 10, y: 20 },
								{ x: 90, y: 20 },
								{ x: 170, y: 80 },
							],
						}}
					/>
				</svg>
			</ReactFlowProvider>,
		);
		expect(container.querySelector("path")?.getAttribute("d")).toBe("M 10 20 L 90 20 L 170 80");
		expect(container.querySelector("circle")?.getAttribute("data-role") ?? null).toBe(role);
		rerender(
			<ReactFlowProvider>
				<svg>
					<ReplayEdge
						id="arc"
						source={source}
						target={target}
						sourceX={10}
						sourceY={20}
						targetX={170}
						targetY={80}
						sourcePosition={Position.Right}
						targetPosition={Position.Left}
						data={{ pulse: 0, transition: null, route: [] }}
					/>
				</svg>
			</ReactFlowProvider>,
		);
		expect(container.querySelector("path")?.getAttribute("d")).toContain("C");
		expect(container.querySelector("circle")).toBeNull();
	},
);
