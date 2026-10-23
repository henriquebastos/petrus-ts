import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { repoRoot, runTool, sandbox } from "./tools.ts";

/** The `line code` pairs a fixture expects: a line that ends with `// TS1234 TS5678 reason` expects those codes. */
function expectedErrors(fixture: string): ReadonlySet<string> {
	const lines = readFileSync(join(repoRoot, fixture), "utf8").split("\n");
	return new Set(
		lines.flatMap((line, index) => {
			const codes = /\/\/ ((?:TS\d+ )+)/.exec(line)?.[1] ?? "";
			return codes
				.trim()
				.split(" ")
				.filter((code) => code !== "")
				.map((code) => `${String(index + 1)} ${code}`);
		}),
	);
}

test.each(["net", "runtime"])(
	"tsc with the real %s tsconfig reports one planted error per compiler flag",
	async (name) => {
		const root = sandbox({
			"tsconfig.base.json": "tsconfig.base.json",
			[`packages/${name}/package.json`]: `packages/${name}/package.json`,
			[`packages/${name}/tsconfig.json`]: `packages/${name}/tsconfig.json`,
			[`packages/${name}/src/defects.ts`]: "fixtures/typecheck/defects.ts",
			[`packages/${name}/src/shapes.ts`]: "fixtures/typecheck/shapes.ts",
		});
		const run = await runTool("tsc", ["-p", `packages/${name}/tsconfig.json`], root);
		const reported = new Set(
			[...run.stdout.matchAll(/defects\.ts\((\d+),\d+\): error (TS\d+)/g)].map(
				(match) => `${match[1] ?? ""} ${match[2] ?? ""}`,
			),
		);
		expect(run.exitCode).not.toBe(0);
		expect(reported).toStrictEqual(expectedErrors("fixtures/typecheck/defects.ts"));
	},
);
