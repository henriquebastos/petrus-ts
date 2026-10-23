import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { readJson, repoRoot, runTool, sandbox } from "./tools.ts";

const mutant = z.object({
	mutatorName: z.string(),
	replacement: z.string(),
	status: z.string(),
	location: z.object({ start: z.object({ line: z.number() }) }),
});
const mutationReport = z.object({ files: z.record(z.string(), z.object({ mutants: z.array(mutant) })) });

test("Stryker reports the untested boundary Survived, the untested function NoCoverage, and kills a net mutant from a runtime test", async () => {
	const root = sandbox({
		"stryker.config.json": "stryker.config.json",
		"vitest.config.ts": "vitest.config.ts",
		"vitest.mutation.config.ts": "vitest.mutation.config.ts",
		"test/mutation-seed.ts": "test/mutation-seed.ts",
		"tsconfig.base.json": "tsconfig.base.json",
		"tsconfig.mutation.json": "tsconfig.mutation.json",
		"packages/net/package.json": "packages/net/package.json",
		"packages/net/src/guard.ts": "fixtures/mutation/guard.ts",
		"packages/net/test/guard.test.ts": "fixtures/mutation/guard.test.ts",
		"packages/net/src/index.ts": "fixtures/mutation/alias/index.ts",
		"packages/net/src/half.ts": "fixtures/mutation/alias/half.ts",
		"packages/runtime/package.json": "packages/runtime/package.json",
		"packages/runtime/node_modules": "packages/runtime/node_modules",
		"packages/runtime/test/half.test.ts": "fixtures/mutation/alias/half.test.ts",
	});
	const run = await runTool("stryker", ["run", "--reporters", "json"], root);
	expect(run.exitCode, run.stdout + run.stderr).toBe(0);
	const report = readJson(join(root, "reports", "mutation", "mutation.json"), mutationReport);
	const outcomes = ["packages/net/src/guard.ts", "packages/net/src/half.ts"]
		.flatMap((file) =>
			(report.files[file]?.mutants ?? []).map(
				(entry) =>
					`${file.slice("packages/net/src/".length)}:${String(entry.location.start.line)} ${entry.mutatorName} ${entry.replacement} ${entry.status}`,
			),
		)
		.sort();
	expect(outcomes).toStrictEqual(
		readJson(join(repoRoot, "fixtures", "mutation", "expected.json"), z.array(z.string())),
	);
});
