import { join } from "node:path";
import { expect, test } from "vitest";
import { expectedRules, repoRoot, runTool } from "./tools.ts";

test("tsc reports the planted strict-flag errors", async () => {
	const fixture = join(repoRoot, "fixtures", "typecheck");
	const run = await runTool("tsc", ["-p", "tsconfig.json"], fixture);
	const codes = new Set([...run.stdout.matchAll(/error (TS\d+)/g)].map((match) => match[1]));
	expect(run.exitCode).not.toBe(0);
	expect(codes).toStrictEqual(expectedRules(join(fixture, "defects.ts")));
});
