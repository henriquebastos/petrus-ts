import { expect, test } from "vitest";
import fc from "fast-check";
import type { NetGraph } from "@petrus/net-view-model";
import { layoutNet } from "../src/index.ts";

test("lays out arbitrary names, cycles, parallel arcs, and isolated nodes without changing topology", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.uniqueArray(fc.string({ minLength: 1, maxLength: 15 }), { minLength: 4, maxLength: 6 }),
			async (names) => {
				const nodes = names.map((name, i) => ({ id: String(i), name, kind: "place" as const, detail: "" }));
				const graph: NetGraph = {
					nodes,
					arcs: [
						{ id: "a", source: "0", target: "1", label: "" },
						{ id: "b", source: "0", target: "1", label: "" },
						{ id: "c", source: "1", target: "2", label: "" },
						{ id: "d", source: "2", target: "0", label: "" },
					],
				};
				const before = JSON.stringify(graph);
				const layout = await layoutNet(graph);
				expect(JSON.stringify(graph)).toBe(before);
				expect(Object.keys(layout.positions).sort()).toStrictEqual(nodes.map(({ id }) => id).sort());
				expect(
					new Set(Object.values(layout.positions).map((point) => `${String(point.x)},${String(point.y)}`)).size,
				).toBe(nodes.length);
				for (const points of Object.values(layout.routes)) {
					expect(points.length).toBeGreaterThanOrEqual(2);
					expect(points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
				}
				expect(Object.keys(layout.routes).sort()).toStrictEqual(["a", "b", "c", "d"]);
				expect(await layoutNet(graph)).toStrictEqual(layout);
			},
		),
		{ numRuns: 8 },
	);
	expect(await layoutNet({ nodes: [], arcs: [] })).toStrictEqual({ positions: {}, routes: {}, labels: {} });
});
