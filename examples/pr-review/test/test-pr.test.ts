import { expect, test } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Gh } from "../src/github.ts";
import { closeTestPr, openTestPr, pushRevision, revisions, samplePath } from "../src/test-pr.ts";

/** The method and repository path of a `gh api` call, such as `POST git/trees`. */
function callOf(args: readonly string[]): string {
	const at = args.indexOf("--method");
	const path = args.find((arg) => arg.startsWith("repos/o/r/")) ?? "";
	return `${at < 0 ? "GET" : String(args[at + 1])} ${path.slice("repos/o/r/".length)}`;
}

/** One repository behind the git data and pulls endpoints: refs, commits with the sample file, and pull requests. */
function fakeRepository(): {
	readonly gh: Gh;
	readonly refs: Map<string, string>;
	readonly files: Map<string, string | undefined>;
	readonly parents: Map<string, string>;
	readonly pulls: { head: string; state: string }[];
} {
	const refs = new Map([["main", "base"]]);
	const files = new Map<string, string | undefined>([["base", undefined]]);
	const parents = new Map<string, string>();
	const trees = new Map<string, string>();
	const pulls: { head: string; state: string }[] = [];
	const Body = Type.Record(Type.String(), Type.Unknown());
	const text = (value: unknown): string => Value.Parse(Type.String(), value);
	const Entries = Type.Array(Type.Object({ path: Type.Literal(samplePath), content: Type.String() }));
	const moveRef = (name: string, sha: string): unknown => ({ object: { sha: refs.set(name, sha).get(name) } });
	type Route = (match: RegExpExecArray, body: Readonly<Record<string, unknown>>) => unknown;
	const routes: (readonly [RegExp, Route])[] = [
		[/^GET git\/ref\/heads\/(.+)$/, ([, name]) => ({ object: { sha: refs.get(text(name)) } })],
		[/^GET git\/commits\/(.+)$/, ([, sha]) => ({ tree: { sha: `tree-of-${text(sha)}` } })],
		[
			/^POST git\/trees$/,
			(_, body) => {
				const sha = `tree-${String(trees.size)}`;
				trees.set(sha, Value.Parse(Entries, body.tree)[0]?.content ?? "");
				return { sha };
			},
		],
		[
			/^POST git\/commits$/,
			(_, body) => {
				const sha = `commit-${String(parents.size)}`;
				parents.set(sha, Value.Parse(Type.Tuple([Type.String()]), body.parents)[0]);
				files.set(sha, trees.get(text(body.tree)));
				return { sha };
			},
		],
		[/^POST git\/refs$/, (_, body) => moveRef(text(body.ref).slice("refs/heads/".length), text(body.sha))],
		[/^PATCH git\/refs\/heads\/(.+)$/, ([, name], body) => moveRef(text(name), text(body.sha))],
		[/^DELETE git\/refs\/heads\/(.+)$/, ([, name]) => (refs.delete(text(name)) ? null : null)],
		[
			/^POST pulls$/,
			(_, body) => {
				pulls.push({ head: text(body.head), state: "open" });
				return { number: pulls.length, html_url: `https://github.com/o/r/pull/${String(pulls.length)}` };
			},
		],
		[
			/^(GET|PATCH) pulls\/(\d+)$/,
			([, method, number], body) => {
				const pull = pulls[Number(number) - 1];
				if (pull !== undefined && method === "PATCH") pull.state = text(body.state);
				return pull === undefined ? undefined : { head: { ref: pull.head, sha: refs.get(pull.head) } };
			},
		],
	];
	const gh: Gh = (args, input) => {
		const body = input === undefined ? {} : Value.Parse(Body, JSON.parse(input));
		const call = callOf(args);
		for (const [pattern, route] of routes) {
			const match = pattern.exec(call);
			if (match !== null) return Promise.resolve({ ok: true, stdout: JSON.stringify(route(match, body)) });
		}
		return Promise.resolve({ ok: false, status: 404, message: `${call}: Not Found (HTTP 404)` });
	};
	return { gh, refs, files, parents, pulls };
}

test("a test pull request starts at revision A on the default branch, takes B and C on top, and closes with its branch", async () => {
	const repo = fakeRepository();
	const branch = "petrus-review-test/1";
	expect(await openTestPr(repo.gh, { owner: "o", repo: "r" }, branch)).toStrictEqual({
		number: 1,
		url: "https://github.com/o/r/pull/1",
	});
	const pull = { owner: "o", repo: "r", number: 1 };
	const b = await pushRevision(repo.gh, pull, "B");
	const c = await pushRevision(repo.gh, pull, "C");
	expect(repo.refs.get(branch)).toBe(c);
	const history = [c];
	for (let sha = repo.parents.get(c); sha !== undefined; sha = repo.parents.get(sha)) history.push(sha);
	expect(history.map((sha) => repo.files.get(sha))).toStrictEqual([
		revisions.C.content,
		revisions.B.content,
		revisions.A.content,
		undefined,
	]);
	expect(history[1]).toBe(b);
	expect(history.at(-1)).toBe("base");
	await closeTestPr(repo.gh, pull);
	expect(repo.pulls).toStrictEqual([{ head: branch, state: "closed" }]);
	expect(repo.refs.has(branch)).toBe(false);
});

test("the revisions differ only where the fixture says: a comment from A to B, the two line defects from B to C", () => {
	const changed = (from: string, to: string): readonly string[] => {
		const before = from.split("\n");
		return to.split("\n").filter((line, i) => line !== before[i]);
	};
	expect(changed(revisions.A.content, revisions.B.content)).toStrictEqual([
		"/** Read access: administrators of the document's own tenant. */",
	]);
	expect(changed(revisions.B.content, revisions.C.content)).toStrictEqual([
		"\treturn user.admin && user.tenant === document.tenant;",
		"\tconst start = (number - 1) * size;",
	]);
});

test("push and close refuse a pull request that is not on a test branch", async () => {
	const repo = fakeRepository();
	repo.pulls.push({ head: "feature", state: "open" });
	repo.refs.set("feature", "base");
	const pull = { owner: "o", repo: "r", number: 1 };
	await expect(pushRevision(repo.gh, pull, "B")).rejects.toThrow("feature is not a test branch");
	await expect(closeTestPr(repo.gh, pull)).rejects.toThrow("feature is not a test branch");
	await expect(openTestPr(repo.gh, { owner: "o", repo: "r" }, "feature")).rejects.toThrow("A test branch starts with");
	expect(repo.pulls).toStrictEqual([{ head: "feature", state: "open" }]);
});
