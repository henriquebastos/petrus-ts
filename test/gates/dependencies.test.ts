import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { readJson, repoRoot, runTool } from "./tools.ts";

const ruleOnFile = z.object({ rule: z.string(), from: z.string() });

const cruiseOutput = z.object({
	summary: z.object({
		totalCruised: z.number(),
		violations: z.array(z.object({ from: z.string(), rule: z.object({ name: z.string() }) })),
	}),
});

async function cruise(cwd: string, config: string): Promise<z.infer<typeof cruiseOutput>> {
	const run = await runTool("depcruise", ["packages", "--config", config, "--output-type", "json"], cwd);
	return cruiseOutput.parse(JSON.parse(run.stdout));
}

test("dependency-cruiser reports each planted violation by rule name", async () => {
	const fixture = join(repoRoot, "fixtures", "deps");
	const output = await cruise(fixture, "../../.dependency-cruiser.cjs");
	const expected = readJson(join(fixture, "expected.json"), z.array(ruleOnFile));
	const reported = output.summary.violations.map((violation) => ({ rule: violation.rule.name, from: violation.from }));
	expect(new Set(reported.map((entry) => JSON.stringify(entry)))).toStrictEqual(
		new Set(expected.map((entry) => JSON.stringify(entry))),
	);
});

test("dependency-cruiser sees the real packages and their cross-package edges", async () => {
	const output = await cruise(repoRoot, ".dependency-cruiser.cjs");
	expect(output.summary.violations).toStrictEqual([]);
	expect(output.summary.totalCruised).toBeGreaterThan(10);
});
