import { execFileSync } from "node:child_process";
import { ESLint } from "eslint";
import { describe, expect, test } from "vitest";
import { expectedRules, repoRoot } from "./tools.ts";

describe("ESLint gate", () => {
	test("reports exactly the planted rules in every lint fixture", async () => {
		const eslint = new ESLint({ cwd: repoRoot, ignore: false });
		const results = await eslint.lintFiles(["fixtures/lint"]);
		expect(results.length).toBeGreaterThan(20);
		for (const result of results) {
			const reported = new Set(result.messages.map((message) => message.ruleId ?? `fatal: ${message.message}`));
			expect({ file: result.filePath, rules: reported }).toStrictEqual({
				file: result.filePath,
				rules: expectedRules(result.filePath),
			});
		}
	});

	test("lints every tracked source file and skips the fixtures", async () => {
		const eslint = new ESLint({ cwd: repoRoot });
		const tracked = execFileSync("git", ["ls-files", "*.ts", "*.js", "*.cjs"], { cwd: repoRoot, encoding: "utf8" })
			.split("\n")
			.filter((path) => path !== "");
		const checks = await Promise.all(
			tracked.map(async (path) => ({ path, ignored: await eslint.isPathIgnored(path) })),
		);
		const wrong = checks.filter(({ path, ignored }) => ignored !== path.startsWith("fixtures/"));
		expect(checks.filter(({ ignored }) => !ignored).length).toBeGreaterThan(30);
		expect(wrong).toStrictEqual([]);
	});
});
