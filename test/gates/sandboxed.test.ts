import { describe, expect, test } from "vitest";
import { runTool, sandbox } from "./tools.ts";

describe("gates that skip fixtures/, run on a sandbox copy of the real config", () => {
	test("Biome fails on a mangled source file", async () => {
		const root = sandbox({
			"biome.json": "biome.json",
			".gitignore": ".gitignore",
			"packages/x/src/mangled.ts": "fixtures/format/mangled.ts",
		});
		const run = await runTool("biome", ["format", "."], root);
		expect(run.exitCode).toBe(1);
		expect(run.stdout + run.stderr).toContain("packages/x/src/mangled.ts");
	});

	test("markdownlint fails on a malformed document", async () => {
		const root = sandbox({
			".markdownlint-cli2.jsonc": ".markdownlint-cli2.jsonc",
			"docs/bad.md": "fixtures/markdown/bad.md",
		});
		const run = await runTool("markdownlint-cli2", [], root);
		const rules = new Set([...run.stderr.matchAll(/ (MD\d{3})\//g)].map((match) => match[1]));
		expect(run.exitCode).toBe(1);
		expect(rules).toStrictEqual(new Set(["MD001", "MD012", "MD022"]));
	});

	test("the coverage threshold fails when a branch has no test", async () => {
		const root = sandbox({
			"vitest.config.ts": "vitest.config.ts",
			"packages/x/src/branch.ts": "fixtures/coverage/branch.ts",
			"packages/x/test/branch.test.ts": "fixtures/coverage/branch.test.ts",
		});
		const run = await runTool("vitest", ["run", "--coverage"], root);
		expect(run.exitCode).toBe(1);
		expect(run.stdout + run.stderr).toMatch(
			/Coverage for branches \([\d.]+%\) does not meet global threshold \(85%\)/,
		);
	});
});
