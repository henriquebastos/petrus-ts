import { join } from "node:path";
import { expect, test } from "vitest";
import { Type } from "typebox";
import { readJson, repoRoot, runScript, sandbox } from "./tools.ts";

const script = "scripts/check-docs.ts";

test("the docs of the real repository pass the docs check", async () => {
	const run = await runScript(script, [], repoRoot);
	expect(run.stderr).toBe("");
	expect(run.exitCode).toBe(0);
});

test("the docs check reports each planted docs defect, in root docs and in package docs", async () => {
	const root = sandbox({
		packages: "packages",
		examples: "examples",
		"knip.json": "knip.json",
		"docs/too-long.md": "fixtures/docs/too-long.md",
		"docs/outside.md": "fixtures/docs/outside.md",
		"docs/missing-path.md": "fixtures/docs/missing-path.md",
		"packages/runtime/docs/wrong-citation.md": "fixtures/docs/wrong-citation.md",
	});
	const run = await runScript(script, [], root);
	expect(run.exitCode).toBe(1);
	const reported = run.stderr.split("\n").filter((line) => line !== "" && !line.endsWith("docs problem(s)."));
	expect(reported).toStrictEqual(
		readJson(join(repoRoot, "fixtures", "docs", "expected.json"), Type.Array(Type.String())),
	);
});
