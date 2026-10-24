import { join } from "node:path";
import { expect, test } from "vitest";
import { Type } from "typebox";
import { parseJson } from "../../scripts/json.ts";
import { readJson, repoRoot, runTool } from "./tools.ts";

const names = Type.Array(Type.Object({ name: Type.String() }));
const knipReport = Type.Object({
	issues: Type.Array(Type.Object({ exports: names, dependencies: names, unlisted: names })),
});
const expectedIssues = Type.Object({
	exports: Type.Array(Type.String()),
	dependencies: Type.Array(Type.String()),
	unlisted: Type.Array(Type.String()),
});

test("knip reports the planted unused export, unused dependency and unlisted import", async () => {
	const fixture = join(repoRoot, "fixtures", "dead");
	const run = await runTool(
		"knip",
		["--config", "../../knip.json", "--reporter", "json", "--no-config-hints"],
		fixture,
	);
	const { issues } = parseJson(run.stdout, knipReport);
	expect(run.exitCode).not.toBe(0);
	expect({
		exports: issues.flatMap((issue) => issue.exports.map((entry) => entry.name)),
		dependencies: issues.flatMap((issue) => issue.dependencies.map((entry) => entry.name)),
		unlisted: issues.flatMap((issue) => issue.unlisted.map((entry) => entry.name)),
	}).toStrictEqual(readJson(join(fixture, "expected.json"), expectedIssues));
});
