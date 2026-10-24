import { join } from "node:path";
import { expect, test } from "vitest";
import type { Static } from "typebox";
import { Type } from "typebox";
import { parseJson } from "../../scripts/json.ts";
import { readJson, repoRoot, runTool } from "./tools.ts";

const ruleOnFile = Type.Object({ rule: Type.String(), from: Type.String() });

const cruiseOutput = Type.Object({
	modules: Type.Array(Type.Object({ source: Type.String() })),
	summary: Type.Object({
		totalCruised: Type.Number(),
		violations: Type.Array(Type.Object({ from: Type.String(), rule: Type.Object({ name: Type.String() }) })),
	}),
});

async function cruise(cwd: string, config: string): Promise<Static<typeof cruiseOutput>> {
	const run = await runTool("depcruise", ["packages", "examples", "--config", config, "--output-type", "json"], cwd);
	return parseJson(run.stdout, cruiseOutput);
}

test("dependency-cruiser reports each planted violation by rule name", async () => {
	const fixture = join(repoRoot, "fixtures", "deps");
	const output = await cruise(fixture, "../../.dependency-cruiser.cjs");
	const expected = readJson(join(fixture, "expected.json"), Type.Array(ruleOnFile));
	const reported = output.summary.violations.map((violation) => ({ rule: violation.rule.name, from: violation.from }));
	expect(new Set(reported.map((entry) => JSON.stringify(entry)))).toStrictEqual(
		new Set(expected.map((entry) => JSON.stringify(entry))),
	);
});

test("dependency-cruiser sees the real packages, the examples and their cross-package edges", async () => {
	const output = await cruise(repoRoot, ".dependency-cruiser.cjs");
	expect(output.summary.violations).toStrictEqual([]);
	expect(output.summary.totalCruised).toBeGreaterThan(10);
	expect(output.modules.some((module) => module.source.startsWith("examples/"))).toBe(true);
});
