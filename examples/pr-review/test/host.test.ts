import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { GitHubFailure } from "../src/github.ts";
import type { GitHub, ReviewPayload } from "../src/github.ts";
import { published, withheld } from "../src/host-net.ts";
import { current, memories } from "../src/net.ts";
import { observe, openHost, watch } from "../src/host.ts";
import type { Host } from "../src/host.ts";
import { marker } from "../src/publication.ts";
import type { PullReviewer, PullReviewInput } from "../src/pull-reviewer.ts";

const context = BACKGROUND_CONTEXT;
const a = "a".repeat(40);
const b = "b".repeat(40);
const base = "0".repeat(40);
// New-file lines 10 to 12 form the only hunk of src/access.ts.
const patch = "@@ -10,2 +10,3 @@\n const user = load();\n+if (user.admin || sameTenant) allow();\n return user;";
const lineFinding = {
	id: "tenant-check",
	kind: "line",
	note: "An administrator of another tenant passes this check.",
	path: "src/access.ts",
	startLine: 11,
	line: 11,
	suggestion: "if (user.admin && sameTenant) allow();",
} as const;
const outside = { ...lineFinding, id: "audit", note: "Log the refusal.", startLine: 40, line: 41, suggestion: "" };
const design = { id: "no-tests", kind: "design", note: "No test covers tenant isolation." } as const;

type Gate = PromiseWithResolvers<undefined>;

/** GitHub with one pull request. Posted reviews are kept so the marker lookup can find them. */
function fakeGitHub(): {
	readonly github: GitHub;
	readonly posted: ReviewPayload[];
	readonly calls: string[];
	readonly creating: Gate;
	loseNextResponse: boolean;
	hold: Gate | undefined;
} {
	const fake = {
		posted: [] as ReviewPayload[],
		calls: [] as string[],
		creating: Promise.withResolvers<undefined>(),
		loseNextResponse: false,
		hold: undefined as Gate | undefined,
		github: {
			login: () => Promise.resolve("octo"),
			pull: () => Promise.resolve({ open: true, head: a, base }),
			compare: () => Promise.resolve([{ filename: "src/access.ts", status: "modified", patch }]),
			findReview: (author: string, mark: string) => {
				fake.calls.push("find");
				const index = fake.posted.findIndex(({ body }) => author === "octo" && body.includes(mark));
				return Promise.resolve(index < 0 ? null : { id: index + 1, url: `review-${String(index + 1)}` });
			},
			createReview: async (payload: ReviewPayload) => {
				fake.calls.push("create");
				fake.creating.resolve(undefined);
				await fake.hold?.promise;
				fake.posted.push(payload);
				if (fake.loseNextResponse) {
					fake.loseNextResponse = false;
					throw new GitHubFailure({ status: 502, message: "Bad Gateway (HTTP 502)" });
				}
				return { id: fake.posted.length, url: `review-${String(fake.posted.length)}` };
			},
		},
	};
	return fake;
}

/** Returns each head's findings; a held head waits until the test releases it. */
function fakeReviewer(findings: (sha: string) => readonly (typeof lineFinding | typeof outside | typeof design)[]): {
	readonly reviewer: PullReviewer;
	readonly inputs: PullReviewInput[];
	readonly holds: Map<string, Gate>;
	readonly called: (count: number) => Promise<void>;
} {
	const inputs: PullReviewInput[] = [];
	const holds = new Map<string, Gate>();
	let next = Promise.withResolvers<undefined>();
	return {
		inputs,
		holds,
		reviewer: async (input) => {
			inputs.push(input);
			next.resolve(undefined);
			await holds.get(input.sha)?.promise;
			return findings(input.sha);
		},
		called: async (count) => {
			while (inputs.length < count) {
				next = Promise.withResolvers<undefined>();
				await next.promise;
			}
		},
	};
}

type Run = Host & {
	readonly lines: string[];
	readonly runReady: () => Promise<void>;
	readonly moveTo: (time: number) => void;
	readonly close: () => Promise<void>;
};

let time = 1000;

/** A state directory as the command uses it. Each call opens it again, as a new process does. */
async function stateDirectory(): Promise<() => Promise<Storage>> {
	const directory = await mkdtemp(join(tmpdir(), "petrus-review-"));
	return () => openNodeJsonlStorage(directory, context);
}

async function open(storage: Storage, github: GitHub, reviewer: PullReviewer, publishing: boolean): Promise<Run> {
	const lines: string[] = [];
	let quiet = Promise.withResolvers<undefined>();
	const host = await openHost(
		storage,
		{ github, reviewer, author: "octo", clock: { now: () => time }, log: (line) => lines.push(line) },
		{
			publishing,
			nonce: randomUUID(),
			harness: {
				onWake: (wake) => {
					if (!wake.active) quiet.resolve(undefined);
				},
			},
		},
		context,
	);
	host.harness.resume();
	return {
		...host,
		lines,
		runReady: async () => {
			quiet = Promise.withResolvers<undefined>();
			host.harness.resume();
			if (host.harness.wake().active) await quiet.promise;
		},
		moveTo: (next) => {
			time = next;
		},
		close: () => host.harness.close(context),
	};
}

const head = (sha: string): { readonly open: true; readonly head: string; readonly base: string } => ({
	open: true,
	head: sha,
	base,
});

test("a fresh report posts one COMMENT review on its commit, with suggestions inline and design findings in the body", async () => {
	const fake = fakeGitHub();
	const review = fakeReviewer(() => [lineFinding, outside, design]);
	const run = await open(new MemoryStorage(), fake.github, review.reviewer, true);
	try {
		expect(await observe(run.instance, head(a), context)).toBe(1);
		await run.runReady();
		expect(fake.posted).toHaveLength(1);
		const [payload] = fake.posted;
		expect(payload).toMatchObject({ commit_id: a, event: "COMMENT" });
		expect(payload?.comments).toStrictEqual([
			{
				path: "src/access.ts",
				line: 11,
				side: "RIGHT",
				body: `${lineFinding.note}\n\n\`\`\`suggestion\n${lineFinding.suggestion}\n\`\`\``,
			},
		]);
		expect(payload?.body).toContain("- **audit**: Log the refusal. (src/access.ts:40-41)");
		expect(payload?.body).toContain(`- **no-tests**: ${design.note}`);
		expect(payload?.body).toContain(marker({ seq: 1, sha: a }));
		const { marking } = await run.instance.state(context);
		expect(marking[published.id]).toStrictEqual([{ seq: 1, sha: a, review: { id: 1, url: "review-1" } }]);
	} finally {
		await run.close();
	}
});

test("a report superseded before classification is withheld, and the next review rechecks its findings", async () => {
	const fake = fakeGitHub();
	const review = fakeReviewer((sha) => (sha === a ? [lineFinding, design] : [lineFinding]));
	const run = await open(new MemoryStorage(), fake.github, review.reviewer, true);
	try {
		review.holds.set(a, Promise.withResolvers<undefined>());
		await observe(run.instance, head(a), context);
		await review.called(1);
		await observe(run.instance, head(b), context);
		review.holds.get(a)?.resolve(undefined);
		await run.runReady();
		expect(review.inputs.map(({ sha }) => sha)).toStrictEqual([a, b]);
		expect(review.inputs[1]?.previous.map(({ id, since }) => [id, since])).toStrictEqual([
			["tenant-check", a],
			["no-tests", a],
		]);
		expect(fake.posted.map(({ commit_id }) => commit_id)).toStrictEqual([b]);
		expect(fake.posted[0]?.body).toContain("1 finding first reported at `aaaaaaa`.");
		const { marking, log } = await run.instance.state(context);
		expect(marking[withheld.id]).toMatchObject([{ seq: 1, sha: a }]);
		expect(marking[published.id]).toMatchObject([{ seq: 2, sha: b }]);
		const order = log.map((entry) => (entry.kind === "ingress" ? entry.requestId : entry.transition));
		expect(order.indexOf("head:2")).toBeLessThan(order.indexOf("Review:reviewed"));
	} finally {
		await run.close();
	}
});

test("a head adopted after classification does not withdraw the classified review", async () => {
	const fake = fakeGitHub();
	const review = fakeReviewer(() => [design]);
	const run = await open(new MemoryStorage(), fake.github, review.reviewer, true);
	try {
		fake.hold = Promise.withResolvers<undefined>();
		await observe(run.instance, head(a), context);
		await fake.creating.promise;
		await observe(run.instance, head(b), context);
		await review.called(2);
		fake.hold.resolve(undefined);
		await run.runReady();
		expect(fake.posted.map(({ commit_id }) => commit_id)).toStrictEqual([a, b]);
		const { marking, log } = await run.instance.state(context);
		expect(marking[withheld.id]).toBeUndefined();
		const order = log.map((entry) => (entry.kind === "ingress" ? entry.requestId : entry.transition));
		expect(order.indexOf("Classify")).toBeLessThan(order.indexOf("head:2"));
	} finally {
		await run.close();
	}
});

test("a restart after GitHub stored a review but the response was lost finds the review instead of posting again", async () => {
	const storage = await stateDirectory();
	const fake = fakeGitHub();
	const review = fakeReviewer(() => []);
	fake.loseNextResponse = true;
	const first = await open(await storage(), fake.github, review.reviewer, true);
	await observe(first.instance, head(a), context);
	await first.runReady();
	expect(first.lines.at(-1)).toMatch(/Publish\/\d+: Bad Gateway \(HTTP 502\); retrying in 60 s/);
	await first.close();
	const second = await open(await storage(), fake.github, review.reviewer, true);
	try {
		second.moveTo(time + 60_000);
		await second.runReady();
		expect(fake.calls).toStrictEqual(["find", "create", "find"]);
		expect(fake.posted).toHaveLength(1);
		expect(fake.posted[0]?.body).toContain("No findings at `aaaaaaa`.");
		expect((await second.instance.state(context)).marking[published.id]).toStrictEqual([
			{ seq: 1, sha: a, review: { id: 1, url: "review-1" } },
		]);
		expect(await observe(second.instance, head(a), context)).toBeUndefined();
		await second.runReady();
		expect(review.inputs).toHaveLength(1);
		expect(await second.instance.inFlight(context)).toStrictEqual([]);
	} finally {
		await second.close();
	}
});

test("a dry run reads no reviews and writes nothing, and its state directory refuses --publish", async () => {
	const storage = await stateDirectory();
	const fake = fakeGitHub();
	const run = await open(await storage(), fake.github, fakeReviewer(() => [lineFinding]).reviewer, false);
	await observe(run.instance, head(a), context);
	await run.runReady();
	expect(fake.calls).toStrictEqual([]);
	expect((await run.instance.state(context)).marking[published.id]).toStrictEqual([{ seq: 1, sha: a, review: null }]);
	expect(run.lines.find((line) => line.startsWith("Dry run"))).toContain(`"commit_id": "${a}"`);
	await run.close();
	await expect(open(await storage(), fake.github, fakeReviewer(() => []).reviewer, true)).rejects.toThrow(
		"This state directory was created without --publish.",
	);
});

test("a failed review holds memory and publishes nothing, while new heads are still adopted", async () => {
	const fake = fakeGitHub();
	const run = await open(
		new MemoryStorage(),
		fake.github,
		() => Promise.reject(new Error("model reply did not match the schema")),
		true,
	);
	try {
		await observe(run.instance, head(a), context);
		await run.runReady();
		await observe(run.instance, head(b), context);
		await run.runReady();
		const { marking } = await run.instance.state(context);
		expect(marking[current.id]).toMatchObject([{ seq: 2, sha: b }]);
		expect(marking[memories.id]).toBeUndefined();
		expect(fake.calls).toStrictEqual([]);
		expect((await run.instance.inFlight(context)).map(({ transition }) => transition)).toStrictEqual(["Review"]);
	} finally {
		await run.close();
	}
});

test("observations follow the head: a return to an earlier commit is a new observation", async () => {
	const run = await open(new MemoryStorage(), fakeGitHub().github, fakeReviewer(() => []).reviewer, false);
	try {
		const seen = [];
		for (const sha of [a, a, b, b, a]) seen.push(await observe(run.instance, head(sha), context));
		expect(seen).toStrictEqual([1, undefined, 2, undefined, 3]);
		await run.runReady();
	} finally {
		await run.close();
	}
});

test("watch admits heads until the pull request closes, waits out a transient read failure, and reports withheld reviews", async () => {
	const fake = fakeGitHub();
	const review = fakeReviewer(() => []);
	const run = await open(new MemoryStorage(), fake.github, review.reviewer, false);
	const pulls = [
		() => Promise.resolve(head(a)),
		() => Promise.reject(new GitHubFailure({ status: undefined, message: "connection reset" })),
		() => Promise.resolve(head(b)),
		() => Promise.resolve({ ...head(b), open: false }),
	];
	review.holds.set(a, Promise.withResolvers<undefined>());
	try {
		const closed = await watch(
			{
				github: { ...fake.github, pull: () => pulls.shift()?.() ?? Promise.reject(new Error("polled too often")) },
				instance: run.instance,
				log: (line) => run.lines.push(line),
				wait: async () => {
					if (pulls.length === 3) await review.called(1);
					if (pulls.length > 1) return;
					review.holds.get(a)?.resolve(undefined);
					await run.runReady();
				},
				stopped: () => false,
			},
			context,
		);
		expect(closed).toBe(true);
		expect(run.lines.filter((line) => !line.startsWith("Dry run"))).toStrictEqual([
			"Admitted head 1 (aaaaaaa)",
			"Could not read the pull request: connection reset",
			"Admitted head 2 (bbbbbbb)",
			"Reviewed head 1 (aaaaaaa): 0 findings",
			"Reviewed head 2 (bbbbbbb): 0 findings",
			"Withheld the review of head 1 (aaaaaaa): head 2 came first",
		]);
	} finally {
		await run.close();
	}
});
