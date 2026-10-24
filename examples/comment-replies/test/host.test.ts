import { definitionOrder } from "@petrus/petri-net";
import type { NetInstanceState, NetInstanceStore, Runtime } from "@petrus/runtime";
import { createRuntime } from "@petrus/runtime";
import { describe, expect, test } from "vitest";
import type { Delivery } from "../src/deliveries.ts";
import { toBatch } from "../src/deliveries.ts";
import { handleDelivery } from "../src/host.ts";
import { comments, free, net, replies } from "../src/net.ts";

function memoryStore(): NetInstanceStore & { readonly stored: () => NetInstanceState } {
	let stored: NetInstanceState = { marking: {}, log: [] };
	return {
		stored: () => stored,
		load: () => Promise.resolve(stored),
		commit: (state) => {
			stored = state;
			return Promise.resolve();
		},
	};
}

function runtimeOver(store: NetInstanceStore): Runtime {
	return createRuntime({ net, store, policy: definitionOrder, clock: { now: () => 1 } });
}

const repo = 4001;

const opened = (id: string, pr: number, repository = repo): Delivery => ({
	id,
	event: "pull_request",
	payload: { action: "opened", repository: { id: repository }, pull_request: { number: pr } },
});

type Commented = {
	readonly pr: number;
	readonly comment: number;
	readonly login?: string;
	readonly repository?: number;
};

const commented = (id: string, { pr, comment, login = "ana", repository = repo }: Commented): Delivery => ({
	id,
	event: "issue_comment",
	payload: {
		action: "created",
		repository: { id: repository },
		issue: { number: pr, pull_request: { url: "https://api.github.com/repos/o/r/pulls/7" } },
		comment: { id: comment, body: "Why?", user: { id: 91, login } },
	},
});

describe("handleDelivery", () => {
	test("answers a comment on an opened pull request and gives the resource token back", async () => {
		const store = memoryStore();
		const runtime = runtimeOver(store);
		await handleDelivery(runtime, opened("d1", 7));
		const handled = await handleDelivery(runtime, commented("d2", { pr: 7, comment: 501 }));
		expect(handled).toMatchObject({ kind: "handled", requestId: "comment:501", fired: [{ transition: "answer" }] });
		expect(store.stored().marking).toStrictEqual({
			[free.id]: [{ repo, pr: 7 }],
			[replies.id]: [{ repo, pr: 7, comment: 501 }],
		});
	});

	test("answers one comment per pull request per step, because the resource token is held for the step", async () => {
		const store = memoryStore();
		const runtime = runtimeOver(store);
		await handleDelivery(runtime, commented("d1", { pr: 7, comment: 501 }));
		await handleDelivery(runtime, commented("d2", { pr: 7, comment: 502 }));
		await runtime.enqueue({ requestId: "pull-request:4001/7", tokens: { [free.id]: [{ repo, pr: 7 }] } });
		expect((await runtime.step()).fired.map((occurrence) => occurrence.binding)).toStrictEqual([
			{ c: { repo, pr: 7, comment: 501, author: 91 }, p: { repo, pr: 7 } },
		]);
		expect((await runtime.step()).fired).toHaveLength(1);
		expect((await runtime.step()).fired).toHaveLength(0);
	});

	test("keeps pull requests with one number in two repositories apart", async () => {
		const store = memoryStore();
		const runtime = runtimeOver(store);
		await handleDelivery(runtime, opened("d1", 7, 4001));
		await handleDelivery(runtime, opened("d2", 7, 4002));
		await handleDelivery(runtime, commented("d3", { pr: 7, comment: 501, repository: 4002 }));
		expect(store.stored().marking[replies.id]).toStrictEqual([{ repo: 4002, pr: 7, comment: 501 }]);
		expect(store.stored().marking[free.id]).toStrictEqual([
			{ repo: 4001, pr: 7 },
			{ repo: 4002, pr: 7 },
		]);
	});

	test("commits nothing for a delivery the app ignores", async () => {
		const store = memoryStore();
		const handled = await handleDelivery(runtimeOver(store), { id: "d1", event: "push", payload: {} });
		expect(handled.kind).toBe("ignored");
		expect(store.stored()).toStrictEqual({ marking: {}, log: [] });
	});

	test("adds a fact once, whether it comes again as a redelivery or as a new delivery", async () => {
		const store = memoryStore();
		const runtime = runtimeOver(store);
		await handleDelivery(runtime, opened("d1", 7));
		await handleDelivery(runtime, commented("d2", { pr: 7, comment: 501 }));
		const redelivered = await handleDelivery(runtime, commented("d2", { pr: 7, comment: 501 }));
		const polledAfterRename = await handleDelivery(
			runtime,
			commented("poll-9", { pr: 7, comment: 501, login: "ana2" }),
		);
		expect([redelivered, polledAfterRename]).toStrictEqual([
			{ kind: "handled", requestId: "comment:501", fired: [] },
			{ kind: "handled", requestId: "comment:501", fired: [] },
		]);
		expect(store.stored().log.map((entry) => entry.kind)).toStrictEqual(["ingress", "ingress", "occurrence"]);
	});
});

describe("toBatch", () => {
	test("names a batch by the fact's own ids, not by the delivery id, and keeps only ids in its tokens", () => {
		expect(toBatch(opened("d1", 7))).toStrictEqual({
			kind: "batch",
			batch: { requestId: "pull-request:4001/7", tokens: { [free.id]: [{ repo, pr: 7 }] } },
		});
		expect(toBatch(commented("d2", { pr: 7, comment: 501 }))).toStrictEqual({
			kind: "batch",
			batch: { requestId: "comment:501", tokens: { [comments.id]: [{ repo, pr: 7, comment: 501, author: 91 }] } },
		});
	});

	test("ignores a comment on an issue, another event, and a payload that does not match", () => {
		const comment = { id: 503, user: { id: 93 } };
		const repository = { id: repo };
		const onIssue = { action: "created", repository, issue: { number: 8 }, comment };
		const closed = { action: "closed", repository, pull_request: { number: 7 } };
		const malformed = { action: "opened", repository, pull_request: { number: "7" } };
		const reason = (event: string): string => `${event} is not an opened pull request or a new pull request comment`;
		const deliveries = [
			{ id: "d1", event: "issue_comment", payload: onIssue },
			{ id: "d2", event: "pull_request", payload: closed },
			{ id: "d3", event: "pull_request", payload: malformed },
			{ id: "d4", event: "push", payload: {} },
		];
		expect(deliveries.map(toBatch)).toStrictEqual([
			{ kind: "ignored", reason: reason("issue_comment") },
			{ kind: "ignored", reason: reason("pull_request") },
			{ kind: "ignored", reason: reason("pull_request") },
			{ kind: "ignored", reason: reason("push") },
		]);
	});
});
