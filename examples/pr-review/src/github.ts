import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { ChangedFile } from "./diff.ts";
import type { Posted } from "./host-net.ts";

/** What `gh` printed: its standard output on success, its error message and HTTP status, when any, on failure. */
export type GhResult =
	| { readonly ok: true; readonly stdout: string }
	| { readonly ok: false; readonly status: number | undefined; readonly message: string };

/** Runs `gh` with these arguments and this standard input, as the user's own login. */
export type Gh = (args: readonly string[], input: string | undefined) => Promise<GhResult>;

export type PullRef = { readonly owner: string; readonly repo: string; readonly number: number };

export type Pull = { readonly open: boolean; readonly head: string; readonly base: string };

/** The fields of a review that `POST /pulls/{n}/reviews` takes. */
export type ReviewPayload = {
	readonly commit_id: string;
	readonly event: "COMMENT";
	readonly body: string;
	readonly comments: readonly ReviewComment[];
};

export type ReviewComment = {
	readonly path: string;
	readonly line: number;
	readonly side: "RIGHT";
	readonly body: string;
	readonly start_line?: number;
	readonly start_side?: "RIGHT";
};

/** A failed `gh` call. A transient one may succeed when repeated later. */
export class GitHubFailure extends Error {
	readonly transient: boolean;

	constructor(result: { readonly status: number | undefined; readonly message: string }) {
		super(result.message);
		this.name = "GitHubFailure";
		this.transient = transient(result.status, result.message);
	}
}

// No status means gh got no HTTP response, as with a network error. GitHub asks clients to wait out rate limits.
function transient(status: number | undefined, message: string): boolean {
	if (status === undefined || status === 429 || status >= 500) return true;
	return status === 403 && /secondary rate limit|abuse detection/i.test(message);
}

/** Runs the `gh` binary as a child process. Its credentials stay in `gh`; the host reads only its output. */
export function ghProcess(binary: string): Gh {
	return (args, input) =>
		new Promise((resolve, reject) => {
			const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
			child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
			child.on("error", reject);
			child.on("close", (code, signal) => {
				const stdout = Buffer.concat(out).toString("utf8");
				const stderr = Buffer.concat(err).toString("utf8") || `gh exited with ${String(code ?? signal)}`;
				resolve(code === 0 ? { ok: true, stdout } : failed(`${stderr}\n${stdout}`));
			});
			child.stdin.end(input ?? "");
		});
}

/** Reads the HTTP status that `gh api` prints in its error, such as `gh: Not Found (HTTP 404)`. */
export function failed(message: string): GhResult {
	const status = /\(HTTP (\d{3})\)/.exec(message)?.[1];
	return { ok: false, status: status === undefined ? undefined : Number(status), message: message.trim() };
}

export function parsePullUrl(url: string): PullRef {
	const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/.exec(url);
	if (match?.[1] === undefined || match[2] === undefined) {
		throw new Error(`Expected a pull request URL such as https://github.com/OWNER/REPO/pull/1, got ${url}`);
	}
	return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

const PullResponse = Type.Object({
	state: Type.String(),
	head: Type.Object({ sha: Type.String() }),
	base: Type.Object({ sha: Type.String() }),
});
const CompareResponse = Type.Object({
	files: Type.Array(
		Type.Object({ filename: Type.String(), status: Type.String(), patch: Type.Optional(Type.String()) }),
	),
});
const ReviewPages = Type.Array(
	Type.Array(
		Type.Object({
			id: Type.Integer(),
			html_url: Type.String(),
			body: Type.Union([Type.String(), Type.Null()]),
			user: Type.Union([Type.Object({ login: Type.String() }), Type.Null()]),
		}),
	),
);
const Created = Type.Object({ id: Type.Integer(), html_url: Type.String() });
const User = Type.Object({ login: Type.String() });

/** The GitHub reads and the one write that the host makes, all through `gh api`. */
export type GitHub = {
	readonly login: () => Promise<string>;
	readonly pull: () => Promise<Pull>;
	readonly compare: (base: string, head: string) => Promise<readonly ChangedFile[]>;
	/** The review by `author` whose body holds `marker`, if GitHub has one. */
	readonly findReview: (author: string, marker: string) => Promise<Posted>;
	readonly createReview: (payload: ReviewPayload) => Promise<NonNullable<Posted>>;
};

/** Calls `gh api` with `input` as the JSON body, and parses the response with `schema`. */
async function ghApi<T extends TSchema>(
	gh: Gh,
	schema: T,
	args: readonly string[],
	input?: unknown,
): Promise<Static<T>> {
	const body = input === undefined ? [] : ["--input", "-"];
	const result = await gh(["api", ...args, ...body], input === undefined ? undefined : JSON.stringify(input));
	if (!result.ok) throw new GitHubFailure(result);
	return Value.Parse(schema, JSON.parse(result.stdout || "null"));
}

export function gitHub(gh: Gh, ref: PullRef): GitHub {
	const repo = `repos/${ref.owner}/${ref.repo}`;
	const pullPath = `${repo}/pulls/${String(ref.number)}`;
	const api = <T extends TSchema>(schema: T, args: readonly string[], input?: unknown): Promise<Static<T>> =>
		ghApi(gh, schema, args, input);
	return {
		login: async () => (await api(User, ["user"])).login,
		pull: async () => {
			const { state, head, base } = await api(PullResponse, [pullPath]);
			return { open: state === "open", head: head.sha, base: base.sha };
		},
		// The three-dot compare of two commit ids is immutable, and it is the diff that GitHub shows for the pull request.
		compare: async (base, head) => (await api(CompareResponse, [`${repo}/compare/${base}...${head}`])).files,
		findReview: async (author, marker) => {
			const pages = await api(ReviewPages, ["--paginate", "--slurp", `${pullPath}/reviews`]);
			const found = pages.flat().find(({ body, user }) => user?.login === author && body?.includes(marker) === true);
			return found === undefined ? null : { id: found.id, url: found.html_url };
		},
		createReview: async (payload) => {
			const created = await api(Created, ["--method", "POST", `${pullPath}/reviews`], payload);
			return { id: created.id, url: created.html_url };
		},
	};
}
