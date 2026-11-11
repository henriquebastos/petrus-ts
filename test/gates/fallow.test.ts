import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Type } from "typebox";
import { parseJson } from "../../scripts/json.ts";
import { commitBaseline, plant, repoRoot, runTool, sandbox } from "./tools.ts";

const complexityFinding = Type.Object({
	path: Type.String(),
	name: Type.String(),
	cyclomatic: Type.Number(),
	crap: Type.Optional(Type.Number()),
	coverage_source: Type.Optional(Type.String()),
	exceeded: Type.String(),
});
const cloneGroup = Type.Object({
	line_count: Type.Number(),
	instances: Type.Array(Type.Object({ file: Type.String() })),
});
const auditReport = Type.Object({
	verdict: Type.String(),
	complexity: Type.Optional(Type.Object({ findings: Type.Array(complexityFinding) })),
	duplication: Type.Optional(Type.Object({ clone_groups: Type.Array(cloneGroup) })),
});
const healthReport = Type.Object({ findings: Type.Array(complexityFinding) });
const dupesReport = Type.Object({ clone_groups: Type.Array(cloneGroup) });

/** The real config and the real packages, committed, so the planted file is the only change `fallow audit` sees. */
function committedPackages(): string {
	const root = sandbox({
		".fallowrc.json": ".fallowrc.json",
		".gitignore": ".gitignore",
		"tsconfig.base.json": "tsconfig.base.json",
		"vitest.config.ts": "vitest.config.ts",
		"packages/petri-net": "packages/petri-net",
		"packages/runtime/src": "packages/runtime/src",
	});
	commitBaseline(root);
	return root;
}

describe("Fallow audit, the inspect gate for CRAP and duplication on changed code", () => {
	test("fails on an uncovered function with cyclomatic complexity 3 (CRAP 12), which the lint limit of 5 allows", async () => {
		const root = committedPackages();
		plant(root, {
			"packages/petri-net/src/retry-delay.ts": "fixtures/crap/retry-delay.ts",
			// The same function in the browser proof script must stay outside the measured-code gate.
			"examples/classics/verify-viewer.ts": "fixtures/crap/retry-delay.ts",
		});
		await runTool("vitest", ["run", "--coverage"], root);
		const run = await runTool("fallow", ["audit", "--format", "json", "--quiet"], root);
		const report = parseJson(run.stdout, auditReport);
		expect(run.exitCode).toBe(1);
		expect(report.verdict).toBe("fail");
		expect(report.complexity?.findings).toStrictEqual([
			{
				path: "packages/petri-net/src/retry-delay.ts",
				name: "retryDelay",
				cyclomatic: 3,
				crap: 12,
				coverage_source: "istanbul",
				exceeded: "crap",
			},
		]);
	});

	test("reports a 30-line block copied between two packages as one clone group, and fails", async () => {
		const root = committedPackages();
		plant(root, {
			"packages/hamsterdan/src/summary.ts": "fixtures/dupes/summary.ts",
			"packages/hamsterdan-github/src/summary.ts": "fixtures/dupes/summary.ts",
		});
		const run = await runTool("fallow", ["audit", "--only", "dupes", "--format", "json", "--quiet"], root);
		const report = parseJson(run.stdout, auditReport);
		expect(run.exitCode).toBe(1);
		expect(report.verdict).toBe("fail");
		expect(
			report.duplication?.clone_groups.map((group) => ({
				lines: group.line_count,
				files: group.instances.map((instance) => instance.file).sort(),
			})),
		).toStrictEqual([
			{
				lines: 30,
				files: ["packages/hamsterdan-github/src/summary.ts", "packages/hamsterdan/src/summary.ts"],
			},
		]);
	});
});

test("the real code has no function at CRAP 10 or above and no clone group", async () => {
	const reports = mkdtempSync(join(tmpdir(), "petrus-coverage-"));
	const coverage = await runTool("vitest", ["run", "--coverage", `--coverage.reportsDirectory=${reports}`], repoRoot);
	expect(coverage.exitCode).toBe(0);
	const health = await runTool(
		"fallow",
		["health", "--complexity", "--coverage", join(reports, "coverage-final.json"), "--format", "json", "--quiet"],
		repoRoot,
	);
	const dupes = await runTool("fallow", ["dupes", "--format", "json", "--quiet"], repoRoot);
	expect({
		exitCode: health.exitCode,
		findings: parseJson(health.stdout, healthReport).findings,
	}).toStrictEqual({
		exitCode: 0,
		findings: [],
	});
	expect({ exitCode: dupes.exitCode, groups: parseJson(dupes.stdout, dupesReport).clone_groups }).toStrictEqual({
		exitCode: 0,
		groups: [],
	});
});
