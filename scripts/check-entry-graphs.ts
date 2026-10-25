/**
 * Entry points are cost contracts (Pi scripts/check-entry-graphs.mjs). Each package root states how many
 * workspace files its value-import graph may reach and which targets it must never reach, so one stray
 * re-export that drags a storage adapter into `petri-net` fails here. `import type` and `export type` edges are
 * erased before Node runs the code, so they do not count. dependency-cruiser resolves the imports; this
 * script only walks its JSON graph. Run from the repository root (the gate test runs it from a sandbox copy).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Type } from "typebox";
import { parseJson } from "./json.ts";

type Budget = { readonly maxFiles: number; readonly forbid: readonly RegExp[] };

/** Budgets are the current graph sizes. Raise one on purpose, in the same change that grows the graph. */
const budgets: Readonly<Record<string, Budget>> = {
	"packages/petri-net/src/index.ts": {
		maxFiles: 9,
		forbid: [/^node:/, /node_modules\//, /^packages\/(?!petri-net\/)/],
	},
	"packages/runtime/src/index.ts": { maxFiles: 20, forbid: [/^node:/] },
};

const cruiseOutput = Type.Object({
	modules: Type.Array(
		Type.Object({
			source: Type.String(),
			dependencies: Type.Array(Type.Object({ resolved: Type.String(), dependencyTypes: Type.Array(Type.String()) })),
		}),
	),
});

type Graph = ReadonlyMap<string, readonly string[]>;

const erasedEdge = new Set(["type-only", "pre-compilation-only"]);

function valueGraph(): Graph {
	const depcruise = join(import.meta.dirname, "..", "node_modules", ".bin", "depcruise");
	const run = spawnSync(depcruise, ["packages", "--config", ".dependency-cruiser.cjs", "--output-type", "json"], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	const { modules } = parseJson(run.stdout, cruiseOutput);
	return new Map(
		modules.map((module) => [
			module.source,
			module.dependencies
				.filter((dependency) => !dependency.dependencyTypes.some((type) => erasedEdge.has(type)))
				.map((dependency) => dependency.resolved),
		]),
	);
}

function reachable(graph: Graph, entry: string): ReadonlySet<string> {
	const seen = new Set<string>();
	const queue = [entry];
	for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
		if (!seen.has(next)) {
			seen.add(next);
			queue.push(...(graph.get(next) ?? []));
		}
	}
	return seen;
}

function violations(graph: Graph, entry: string, budget: Budget): readonly string[] {
	if (!graph.has(entry)) {
		return [`${entry} has a budget but dependency-cruiser did not see it`];
	}
	const reached = [...reachable(graph, entry)].sort();
	return [
		...fileBudgetViolations(entry, reached, budget.maxFiles),
		...forbiddenTargets(entry, reached, budget.forbid),
	];
}

function fileBudgetViolations(entry: string, reached: readonly string[], maxFiles: number): readonly string[] {
	const files = reached.filter((target) => target.startsWith("packages/"));
	if (files.length <= maxFiles) {
		return [];
	}
	return [`${entry} reaches ${String(files.length)} files, budget ${String(maxFiles)}:\n    ${files.join("\n    ")}`];
}

function forbiddenTargets(entry: string, reached: readonly string[], forbid: readonly RegExp[]): readonly string[] {
	return forbid.flatMap((pattern) => {
		const hits = reached.filter((target) => pattern.test(target));
		return hits.length === 0 ? [] : [`${entry} must not reach ${String(pattern)}:\n    ${hits.join("\n    ")}`];
	});
}

const graph = valueGraph();
const failures = Object.entries(budgets).flatMap(([entry, budget]) => violations(graph, entry, budget));
for (const failure of failures) {
	console.error(failure);
}
if (failures.length > 0) {
	console.error(`${String(failures.length)} entry-graph budget violation(s).`);
	process.exitCode = 1;
}
