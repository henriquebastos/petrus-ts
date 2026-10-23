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
});
