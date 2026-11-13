import { Type } from "typebox";
import { ghApi } from "./github.ts";
import type { Gh, PullRef } from "./github.ts";

/** Test pull requests live on branches with this prefix. Push and close refuse any other branch. */
export const branchPrefix = "petrus-review-test/";
export const samplePath = "examples/pr-review/sample/documents.ts";

const header = `export type User = { readonly id: string; readonly tenant: string; readonly admin: boolean };
export type Document = { readonly id: string; readonly tenant: string; readonly title: string };
`;
const rest = (canRead: string, start: string): string => `
export function canRead(user: User, document: Document): boolean {
	return ${canRead};
}

/** Returns page \`number\` of \`items\`, \`size\` items per page. Pages count from 1. */
export function page<T>(items: readonly T[], number: number, size: number): readonly T[] {
	const start = ${start};
	return items.slice(start, start + size);
}

const loaded = new Map<string, Document>();

/** Loads a document once per process and keeps it for later reads. */
export function load(id: string, fetch: (id: string) => Document): Document {
	const cached = loaded.get(id);
	if (cached !== undefined) return cached;
	const document = fetch(id);
	loaded.set(id, document);
	return document;
}

/** Titles of the documents that \`user\` may read, one page at a time. */
export function titles(user: User, documents: readonly Document[], number: number): readonly string[] {
	return page(documents, number, 20)
		.filter((document) => canRead(user, document))
		.map((document) => document.title);
}
`;

/**
 * Fixed revisions of one sample file. A has two line defects (the access rule and the page offset) and two design
 * defects (an unbounded cache shared by all tenants, and filtering after paging). B changes only a comment. C fixes
 * the line defects and keeps the design defects, so C's review carries findings first reported at A.
 */
export const revisions = {
	A: {
		message: "test: add sample document access",
		content: `${header}\n/** Only an administrator of the document's tenant may read it. */${rest("user.admin || user.tenant === document.tenant", "number * size")}`,
	},
	B: {
		message: "test: reword the access comment",
		content: `${header}\n/** Read access: administrators of the document's own tenant. */${rest("user.admin || user.tenant === document.tenant", "number * size")}`,
	},
	C: {
		message: "test: require both access conditions and count pages from 1",
		content: `${header}\n/** Read access: administrators of the document's own tenant. */${rest("user.admin && user.tenant === document.tenant", "(number - 1) * size")}`,
	},
} as const;
export type RevisionName = keyof typeof revisions;

const Sha = Type.Object({ sha: Type.String() });
const Ref = Type.Object({ object: Sha });
const Commit = Type.Object({ tree: Sha });
const Pull = Type.Object({ head: Type.Object({ ref: Type.String(), sha: Type.String() }) });
const Opened = Type.Object({ number: Type.Integer(), html_url: Type.String() });

/** Creates `branch` from the default branch with revision A and opens a pull request for it. */
export async function openTestPr(
	gh: Gh,
	repo: Omit<PullRef, "number">,
	branch: string,
): Promise<{ readonly number: number; readonly url: string }> {
	if (!branch.startsWith(branchPrefix)) throw new Error(`A test branch starts with ${branchPrefix}`);
	const path = `repos/${repo.owner}/${repo.repo}`;
	const base = (await ghApi(gh, Ref, [`${path}/git/ref/heads/main`])).object.sha;
	const sha = await commitRevision(gh, path, base, "A");
	await ghApi(gh, Ref, ["--method", "POST", `${path}/git/refs`], { ref: `refs/heads/${branch}`, sha });
	const opened = await ghApi(gh, Opened, ["--method", "POST", `${path}/pulls`], {
		title: "Petrus review test: sample document access",
		head: branch,
		base: "main",
		body: `A test pull request for \`petrus review\`, made by \`examples/pr-review/src/test-pr.ts\`. Do not merge.\n\nRevisions: A, then B and C on demand. See \`examples/pr-review/README.md\`.`,
	});
	return { number: opened.number, url: opened.html_url };
}

/** Commits revision `name` on top of the test pull request's head and moves its branch there. */
export async function pushRevision(gh: Gh, pull: PullRef, name: RevisionName): Promise<string> {
	const { path, head } = await testHead(gh, pull);
	const sha = await commitRevision(gh, path, head.sha, name);
	await ghApi(gh, Ref, ["--method", "PATCH", `${path}/git/refs/heads/${head.ref}`], { sha });
	return sha;
}

/** Closes the test pull request and deletes its branch. */
export async function closeTestPr(gh: Gh, pull: PullRef): Promise<void> {
	const { path, head } = await testHead(gh, pull);
	await ghApi(gh, Type.Unknown(), ["--method", "PATCH", `${path}/pulls/${String(pull.number)}`], { state: "closed" });
	await ghApi(gh, Type.Null(), ["--method", "DELETE", `${path}/git/refs/heads/${head.ref}`]);
}

async function testHead(
	gh: Gh,
	pull: PullRef,
): Promise<{ readonly path: string; readonly head: { readonly ref: string; readonly sha: string } }> {
	const path = `repos/${pull.owner}/${pull.repo}`;
	const { head } = await ghApi(gh, Pull, [`${path}/pulls/${String(pull.number)}`]);
	if (!head.ref.startsWith(branchPrefix)) throw new Error(`${head.ref} is not a test branch`);
	return { path, head };
}

async function commitRevision(gh: Gh, path: string, parent: string, name: RevisionName): Promise<string> {
	const { message, content } = revisions[name];
	const baseTree = (await ghApi(gh, Commit, [`${path}/git/commits/${parent}`])).tree.sha;
	const tree = await ghApi(gh, Sha, ["--method", "POST", `${path}/git/trees`], {
		base_tree: baseTree,
		tree: [{ path: samplePath, mode: "100644", type: "blob", content }],
	});
	const commit = await ghApi(gh, Sha, ["--method", "POST", `${path}/git/commits`], {
		message,
		tree: tree.sha,
		parents: [parent],
	});
	return commit.sha;
}
