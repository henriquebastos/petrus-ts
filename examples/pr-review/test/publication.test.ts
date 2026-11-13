import { expect, test } from "vitest";
import { parseCommand } from "../src/command.ts";
import { anchors, readDiff } from "../src/diff.ts";
import { failed, ghProcess, gitHub, GitHubFailure } from "../src/github.ts";
import type { Gh } from "../src/github.ts";
import type { HostReport } from "../src/host-net.ts";
import { renderReview } from "../src/publication.ts";
import { settleFindings } from "../src/pull-reviewer.ts";

// Two hunks: new lines 3 to 6, then 20 to 21. Line 4 is added; one old line is removed before line 5.
const patch = [
	"@@ -3,4 +3,4 @@ function access()",
	" const user = load();",
	"+const tenant = user.tenant;",
	"-const legacy = true;",
	" if (user.admin) allow();",
	" return user;",
	"@@ -20,2 +20,2 @@",
	"-old();",
	"+next();",
	" done();",
].join("\n");
const diff = readDiff([{ filename: "src/a.ts", status: "modified", patch }], 10_000);

test("numbers new-file lines and accepts an anchor only inside one hunk", () => {
	expect(diff.text.split("\n").slice(1, 7)).toStrictEqual([
		"@@ -3,4 +3,4 @@ function access()",
		"    3  const user = load();",
		"    4 +const tenant = user.tenant;",
		"      -const legacy = true;",
		"    5  if (user.admin) allow();",
		"    6  return user;",
	]);
	expect(diff.text).toContain("   20 +next();\n   21  done();");
	expect([
		anchors(diff, "src/a.ts", 3, 6),
		anchors(diff, "src/a.ts", 20, 21),
		anchors(diff, "src/a.ts", 6, 20),
		anchors(diff, "src/a.ts", 7, 7),
		anchors(diff, "src/a.ts", 2, 3),
		anchors(diff, "src/a.ts", 5, 4),
		anchors(diff, "src/b.ts", 4, 4),
	]).toStrictEqual([true, true, false, false, false, false, false]);
});

test("keeps the names of files whose patch is missing or over the budget, and anchors nothing in them", () => {
	const small = readDiff(
		[
			{ filename: "logo.png", status: "added" },
			{ filename: "src/a.ts", status: "modified", patch },
			{ filename: "src/big.ts", status: "added", patch: "@@ -0,0 +1,1 @@\n+x" },
		],
		patch.length,
	);
	expect(small.text).toContain("### logo.png (added)\nPatch omitted: GitHub sent none.");
	expect(small.text).toContain("### src/big.ts (added)\nPatch omitted: diff too large.");
	expect([anchors(small, "src/a.ts", 4, 4), anchors(small, "src/big.ts", 1, 1)]).toStrictEqual([true, false]);
});

test("settled findings keep the commit that first reported them and turn anchors outside the diff into design findings", () => {
	const line = { id: "x", kind: "line", note: "N", path: "src/a.ts", startLine: 4, line: 5, suggestion: "s" } as const;
	expect(
		settleFindings(
			[line, { ...line, id: "y", startLine: 6, line: 20 }, { id: "z", kind: "design", note: "D" }],
			diff,
			[{ id: "x", kind: "design", note: "old", since: "first" }],
			"now",
		),
	).toStrictEqual([
		{ ...line, since: "first" },
		{ id: "y", kind: "design", note: "N (src/a.ts:6-20)", since: "now" },
		{ id: "z", kind: "design", note: "D", since: "now" },
	]);
});

const report = (findings: HostReport["findings"]): HostReport => ({ seq: 4, sha: "c".repeat(40), base: "b", findings });

test("a review with no findings still names its commit, its author and its marker", () => {
	expect(renderReview(report([]), "octo")).toStrictEqual({
		commit_id: "c".repeat(40),
		event: "COMMENT",
		body: [
			"### Petrus review of `ccccccc`",
			"No findings at `ccccccc`.",
			`Posted by \`petrus review\` as @octo.\n<!-- petrus-review seq=4 sha=${"c".repeat(40)} -->`,
		].join("\n\n"),
		comments: [],
	});
});

test("a multi-line suggestion spans its lines, and its fence outlasts any backtick run inside it", () => {
	const finding = {
		id: "fence",
		kind: "line",
		note: "Quote the example.",
		path: "README.md",
		startLine: 2,
		line: 3,
		suggestion: "```sh\nrun\n```\n",
		since: "a".repeat(40),
	} as const;
	const payload = renderReview(
		report([finding, { id: "plain", kind: "design", note: "D", since: "c".repeat(40) }]),
		"octo",
	);
	expect(payload.comments).toStrictEqual([
		{
			path: "README.md",
			line: 3,
			side: "RIGHT",
			start_line: 2,
			start_side: "RIGHT",
			body: "Quote the example.\n\n````suggestion\n```sh\nrun\n```\n````",
		},
	]);
	expect(payload.body).toContain("2 findings, 1 as comments on the diff.");
	expect(payload.body).toContain("- **plain**: D");
	expect(payload.body).toContain("1 finding first reported at `aaaaaaa`.");
});

test("gh failures are transient for no response, rate limits and server errors only", () => {
	const kinds = [
		"error connecting to api.github.com",
		"gh: Server Error (HTTP 502)",
		"gh: API rate limit exceeded (HTTP 429)",
		"gh: You have exceeded a secondary rate limit (HTTP 403)",
		"gh: Resource not accessible by integration (HTTP 403)",
		"gh: Validation Failed (HTTP 422)",
		"gh: Not Found (HTTP 404)",
	].map((message) => {
		const result = failed(message);
		if (result.ok) throw new Error("failed must not succeed");
		return new GitHubFailure(result).transient;
	});
	expect(kinds).toStrictEqual([true, true, true, true, false, false, false]);
});

test("the marker lookup reads every page and counts only the given author's reviews", async () => {
	const calls: (readonly string[])[] = [];
	const gh: Gh = (args, input) => {
		calls.push([...args, input ?? ""]);
		const review = (id: number, login: string, body: string | null): object => ({
			id,
			html_url: `u${String(id)}`,
			body,
			user: { login },
		});
		const stdout = args.includes("POST")
			? JSON.stringify({ id: 9, html_url: "u9" })
			: JSON.stringify([
					[review(1, "mallory", "<!-- m -->"), review(2, "octo", null)],
					[review(3, "octo", "x <!-- m -->")],
				]);
		return Promise.resolve({ ok: true, stdout });
	};
	const github = gitHub(gh, { owner: "o", repo: "r", number: 7 });
	expect(await github.findReview("octo", "<!-- m -->")).toStrictEqual({ id: 3, url: "u3" });
	expect(await github.findReview("octo", "<!-- other -->")).toBeNull();
	const payload = { commit_id: "c", event: "COMMENT", body: "b", comments: [] } as const;
	expect(await github.createReview(payload)).toStrictEqual({ id: 9, url: "u9" });
	expect(calls[0]).toStrictEqual(["api", "--paginate", "--slurp", "repos/o/r/pulls/7/reviews", ""]);
	expect(calls[2]).toStrictEqual([
		"api",
		"--method",
		"POST",
		"repos/o/r/pulls/7/reviews",
		"--input",
		"-",
		JSON.stringify(payload),
	]);
	await expect(
		gitHub(() => Promise.resolve(failed("gh: Not Found (HTTP 404)")), { owner: "o", repo: "r", number: 7 }).pull(),
	).rejects.toMatchObject({
		transient: false,
	});
});

test("the gh process passes standard input through and reports a failed exit with its HTTP status", async () => {
	const node = ghProcess(process.execPath);
	expect(await node(["-e", "process.stdin.pipe(process.stdout)"], '{"ok":1}')).toStrictEqual({
		ok: true,
		stdout: '{"ok":1}',
	});
	expect(
		await node(["-e", "console.error('gh: Validation Failed (HTTP 422)'); process.exit(1)"], undefined),
	).toStrictEqual({
		ok: false,
		status: 422,
		message: "gh: Validation Failed (HTTP 422)",
	});
	expect(await node(["-e", "process.exit(2)"], undefined)).toMatchObject({ ok: false, message: "gh exited with 2" });
	await expect(ghProcess("/nonexistent/gh")(["api"], undefined)).rejects.toThrow("ENOENT");
});

test("the command takes one pull request URL, publishes only when asked, and keeps state per pull request", () => {
	expect(parseCommand(["review", "https://github.com/o/r.x/pull/12"])).toStrictEqual({
		pull: { owner: "o", repo: "r.x", number: 12 },
		publish: false,
		state: ".petrus/o/r.x/12",
		intervalMs: 60_000,
	});
	expect(
		parseCommand(["review", "https://github.com/o/r/pull/3/", "--publish", "--state", "/s", "--interval", "15"]),
	).toMatchObject({ publish: true, state: "/s", intervalMs: 15_000 });
	for (const argv of [
		["https://github.com/o/r/pull/3"],
		["review", "https://github.com/o/r/issues/3"],
		["review", "https://github.com/o/r/pull/3", "extra"],
		["review", "https://github.com/o/r/pull/3", "--interval", "5"],
		["review", "https://github.com/o/r/pull/3", "--interval", "soon"],
	]) {
		expect(() => parseCommand(argv)).toThrow();
	}
});
