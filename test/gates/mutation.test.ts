import { join } from "node:path";
import { expect, test } from "vitest";
import { Type } from "typebox";
import { mutationInputsChanged } from "../../scripts/mutation-inputs.ts";
import { readJson, repoRoot, runTool, sandbox } from "./tools.ts";

const mutant = Type.Object({
	mutatorName: Type.String(),
	replacement: Type.String(),
	status: Type.String(),
	location: Type.Object({ start: Type.Object({ line: Type.Number() }) }),
});
const mutationReport = Type.Object({ files: Type.Record(Type.String(), Type.Object({ mutants: Type.Array(mutant) })) });

test("Stryker reports the untested boundary Survived, the untested function NoCoverage, kills a petri-net mutant from a runtime test, and fails below the break score of 100", async () => {
	const root = sandbox({
		"stryker.config.json": "stryker.config.json",
		"vitest.config.ts": "vitest.config.ts",
		"vitest.mutation.config.ts": "vitest.mutation.config.ts",
		"test/mutation-seed.ts": "test/mutation-seed.ts",
		"tsconfig.base.json": "tsconfig.base.json",
		"tsconfig.mutation.json": "tsconfig.mutation.json",
		"packages/petri-net/package.json": "packages/petri-net/package.json",
		"packages/petri-net/src/guard.ts": "fixtures/mutation/guard.ts",
		"packages/petri-net/test/guard.test.ts": "fixtures/mutation/guard.test.ts",
		"packages/petri-net/src/index.ts": "fixtures/mutation/alias/index.ts",
		"packages/petri-net/src/half.ts": "fixtures/mutation/alias/half.ts",
		"packages/runtime/package.json": "packages/runtime/package.json",
		"packages/runtime/node_modules": "packages/runtime/node_modules",
		"packages/runtime/test/half.test.ts": "fixtures/mutation/alias/half.test.ts",
	});
	const run = await runTool("stryker", ["run", "--reporters", "json"], root);
	expect(run.exitCode, run.stdout + run.stderr).toBe(1);
	expect(run.stdout + run.stderr).toContain("under breaking threshold");
	const report = readJson(join(root, "reports", "mutation", "mutation.json"), mutationReport);
	const outcomes = ["packages/petri-net/src/guard.ts", "packages/petri-net/src/half.ts"]
		.flatMap((file) =>
			(report.files[file]?.mutants ?? []).map(
				(entry) =>
					`${file.slice("packages/petri-net/src/".length)}:${String(entry.location.start.line)} ${entry.mutatorName} ${entry.replacement} ${entry.status}`,
			),
		)
		.sort();
	expect(outcomes).toStrictEqual(
		readJson(join(repoRoot, "fixtures", "mutation", "expected.json"), Type.Array(Type.String())),
	);
});

test("the pre-push hook skips mutation testing only for commits that change no package, Stryker, Vitest, TypeScript or dependency file", () => {
	const outside = ["README.md", "examples/pr-review/src/host.ts", "test/gates/docs.test.ts", "scripts/check-docs.ts"];
	expect(mutationInputsChanged(outside)).toBe(false);
	expect(mutationInputsChanged([])).toBe(false);
	const inputs = [
		"packages/runtime/src/runtime.ts",
		"packages/net-view-model/test/project.test.ts",
		"stryker.config.json",
		"vitest.config.ts",
		"vitest.mutation.config.ts",
		"tsconfig.base.json",
		"tsconfig.mutation.json",
		"test/mutation-seed.ts",
		"package.json",
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
		".node-version",
	];
	for (const path of inputs) expect(mutationInputsChanged([...outside, path]), path).toBe(true);
	expect(mutationInputsChanged(["examples/pr-review/package.json", "examples/pr-review/tsconfig.json"])).toBe(false);
});
