import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const main = join(import.meta.dirname, "..", "src", "main.ts");
const sample = (name: string): string => join(import.meta.dirname, "..", "sample", name);

function run(state: string, deliveries: readonly string[]): readonly string[] {
	const result = spawnSync(process.execPath, [main, state, ...deliveries.map(sample)], { encoding: "utf8" });
	expect({ status: result.status, stderr: result.stderr }).toStrictEqual({ status: 0, stderr: "" });
	return result.stdout.trim().split("\n");
}

test("runs the sample deliveries, and a second run of the same deliveries adds nothing", () => {
	const state = join(mkdtempSync(join(tmpdir(), "comment-replies-")), "state");
	const deliveries = ["1-opened.json", "2-comment.json", "3-comment.json", "3-comment.json", "4-issue-comment.json"];
	const marking =
		'{"replies":[{"repo":4001,"pr":7,"comment":501},{"repo":4001,"pr":7,"comment":502}],"free":[{"repo":4001,"pr":7}]}';
	const ignored = "d4 ignored: issue_comment is not an opened pull request or a new pull request comment";
	expect(run(state, deliveries)).toStrictEqual([
		"d1 fired 0",
		"d2 fired 1",
		"d3 fired 1",
		"d3 fired 0",
		ignored,
		marking,
	]);
	expect(run(state, deliveries)).toStrictEqual([
		"d1 fired 0",
		"d2 fired 0",
		"d3 fired 0",
		"d3 fired 0",
		ignored,
		marking,
	]);
});
