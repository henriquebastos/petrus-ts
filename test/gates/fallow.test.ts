import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { commitBaseline, plant, repoRoot, runTool, sandbox } from "./tools.ts";

const complexityFinding = z.object({
	path: z.string(),
	name: z.string(),
	cyclomatic: z.number(),
	crap: z.number().optional(),
	coverage_source: z.string().optional(),
	exceeded: z.string(),
});
const cloneGroup = z.object({
	line_count: z.number(),
	instances: z.array(z.object({ file: z.string() })),
});
const auditReport = z.object({
	verdict: z.string(),
	complexity: z.object({ findings: z.array(complexityFinding) }).optional(),
	duplication: z.object({ clone_groups: z.array(cloneGroup) }).optional(),
});
const healthReport = z.object({ findings: z.array(complexityFinding) });
const dupesReport = z.object({ clone_groups: z.array(cloneGroup) });

/** The real config and the real packages, committed, so the planted file is the only change `fallow audit` sees. */
function committedPackages(): string {
	const root = sandbox({
		".fallowrc.json": ".fallowrc.json",
		".gitignore": ".gitignore",
		"tsconfig.base.json": "tsconfig.base.json",
		"vitest.config.ts": "vitest.config.ts",
		"packages/net": "packages/net",
		"packages/runtime/src": "packages/runtime/src",
	});
	commitBaseline(root);
	return root;
}

describe("Fallow audit, the inspect gate for CRAP and duplication on changed code", () => {
	test("fails on an uncovered function with cyclomatic complexity 8 (CRAP 72), read from Istanbul coverage", async () => {
		const root = committedPackages();
		plant(root, { "packages/net/src/retry-delay.ts": "fixtures/crap/retry-delay.ts" });
		await runTool("vitest", ["run", "--coverage"], root);
		const run = await runTool("fallow", ["audit", "--format", "json", "--quiet"], root);
		const report = auditReport.parse(JSON.parse(run.stdout));
		expect(run.exitCode).toBe(1);
		expect(report.verdict).toBe("fail");
		expect(report.complexity?.findings).toStrictEqual([
			{
				path: "packages/net/src/retry-delay.ts",
				name: "retryDelay",
				cyclomatic: 8,
				crap: 72,
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
		const report = auditReport.parse(JSON.parse(run.stdout));
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

test("the real code has no function at CRAP 30 or above and no clone group", async () => {
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
		findings: healthReport.parse(JSON.parse(health.stdout)).findings,
	}).toStrictEqual({
		exitCode: 0,
		findings: [],
	});
	expect({ exitCode: dupes.exitCode, groups: dupesReport.parse(JSON.parse(dupes.stdout)).clone_groups }).toStrictEqual(
		{
			exitCode: 0,
			groups: [],
		},
	);
});
