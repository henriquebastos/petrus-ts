import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { repoRoot, runScript, sandbox } from "./tools.ts";

const script = "scripts/check-entry-graphs.ts";

test("the entry-graph budget holds for the real package roots", async () => {
	const run = await runScript(script, [], repoRoot);
	expect(run.stderr).toBe("");
	expect(run.exitCode).toBe(0);
});

test("an `export *` of a node:sqlite module in the net root breaks the net and runtime budgets", async () => {
	const root = sandbox({
		".dependency-cruiser.cjs": ".dependency-cruiser.cjs",
		"tsconfig.base.json": "tsconfig.base.json",
		packages: "packages",
		"packages/net/src/storage.ts": "fixtures/entry-graphs/storage.ts",
	});
	appendFileSync(
		join(root, "packages/net/src/index.ts"),
		readFileSync(join(repoRoot, "fixtures/entry-graphs/net-index-tail.ts")),
	);
	const run = await runScript(script, [], root);
	expect(run.exitCode).toBe(1);
	expect(run.stderr).toContain("packages/net/src/index.ts reaches 6 files, budget 5");
	expect(run.stderr).toContain("packages/net/src/index.ts must not reach /^node:/:\n    node:sqlite");
	expect(run.stderr).toContain("packages/runtime/src/index.ts must not reach /^node:/:\n    node:sqlite");
});
