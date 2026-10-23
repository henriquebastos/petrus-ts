import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { readJson, repoRoot, runTool } from "./tools.ts";

const names = z.array(z.object({ name: z.string() }));
const knipReport = z.object({
	issues: z.array(z.object({ exports: names, dependencies: names, unlisted: names })),
});
const expectedIssues = z.object({
	exports: z.array(z.string()),
	dependencies: z.array(z.string()),
	unlisted: z.array(z.string()),
});

test("knip reports the planted unused export, unused dependency and unlisted import", async () => {
	const fixture = join(repoRoot, "fixtures", "dead");
	const run = await runTool(
		"knip",
		["--config", "../../knip.json", "--reporter", "json", "--no-config-hints"],
		fixture,
	);
	const { issues } = knipReport.parse(JSON.parse(run.stdout));
	expect(run.exitCode).not.toBe(0);
	expect({
		exports: issues.flatMap((issue) => issue.exports.map((entry) => entry.name)),
		dependencies: issues.flatMap((issue) => issue.dependencies.map((entry) => entry.name)),
		unlisted: issues.flatMap((issue) => issue.unlisted.map((entry) => entry.name)),
	}).toStrictEqual(readJson(join(fixture, "expected.json"), expectedIssues));
});
