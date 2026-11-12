import { MemoryStorage } from "@earendil-works/pi-durable";
import { definitionOrder, fireStep } from "@petrus/petri-net";
import { describe, expect, onTestFinished, test } from "vitest";
import type { Delivery } from "../src/deliveries.ts";
import { toBatch } from "../src/deliveries.ts";
import { handleDelivery } from "../src/host.ts";
import { comments, free, net, replies } from "../src/net.ts";
import { context, openInstance } from "./harness.ts";
import type { Opened } from "./harness.ts";

/** The net instance of a new Harness over memory storage; the test closes the Harness. */
async function memoryInstance(): Promise<Opened> {
	const opened = await openInstance(new MemoryStorage());
	onTestFinished(opened.close);
	return opened;
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
		const { instance, settle } = await memoryInstance();
		await handleDelivery(instance, opened("d1", 7), context);
		const handled = await handleDelivery(instance, commented("d2", { pr: 7, comment: 501 }), context);
		expect(handled).toMatchObject({ kind: "handled", requestId: "comment:501", fired: [{ transition: "answer" }] });
		expect((await instance.state(context)).marking[replies.id]).toBeUndefined();
		await settle();
		expect((await instance.state(context)).marking).toStrictEqual({
			[free.id]: [{ repo, pr: 7 }],
			[replies.id]: [{ repo, pr: 7, comment: 501 }],
		});
	});

	test("holds the resource while a reply is pending and answers the next comment after settlement", async () => {
		const { instance, settle } = await memoryInstance();
		await handleDelivery(instance, commented("d1", { pr: 7, comment: 501 }), context);
		await handleDelivery(instance, commented("d2", { pr: 7, comment: 502 }), context);
		const waiting = (await instance.state(context)).marking;
		const pull = { repo, pr: 7 };
		expect(fireStep(net, { ...waiting, [free.id]: [pull] }, definitionOrder).fired).toStrictEqual([
			{ transition: "answer", binding: { c: { repo, pr: 7, comment: 501, author: 91 }, p: pull } },
		]);
		const handled = await handleDelivery(instance, opened("d3", 7), context);
		expect(handled).toMatchObject({
			fired: [{ binding: { c: { comment: 501 } } }],
		});
		expect((await instance.state(context)).marking[free.id]).toBeUndefined();
		await settle();
		expect((await instance.state(context)).marking[replies.id]).toStrictEqual([
			{ repo, pr: 7, comment: 501 },
			{ repo, pr: 7, comment: 502 },
		]);
	});

	test("keeps pull requests with one number in two repositories apart", async () => {
		const { instance, settle } = await memoryInstance();
		await handleDelivery(instance, opened("d1", 7, 4001), context);
		await handleDelivery(instance, opened("d2", 7, 4002), context);
		await handleDelivery(instance, commented("d3", { pr: 7, comment: 501, repository: 4002 }), context);
		await settle();
		const { marking } = await instance.state(context);
		expect(marking[replies.id]).toStrictEqual([{ repo: 4002, pr: 7, comment: 501 }]);
		expect(marking[free.id]).toStrictEqual([
			{ repo: 4001, pr: 7 },
			{ repo: 4002, pr: 7 },
		]);
	});

	test("commits nothing for a delivery the app ignores", async () => {
		const { instance } = await memoryInstance();
		const handled = await handleDelivery(instance, { id: "d1", event: "push", payload: {} }, context);
		expect(handled.kind).toBe("ignored");
		expect(await instance.state(context)).toStrictEqual({ marking: {}, log: [] });
	});

	test("adds a fact once, whether it comes again as a redelivery or as a new delivery", async () => {
		const { instance, settle } = await memoryInstance();
		await handleDelivery(instance, opened("d1", 7), context);
		await handleDelivery(instance, commented("d2", { pr: 7, comment: 501 }), context);
		const redelivered = await handleDelivery(instance, commented("d2", { pr: 7, comment: 501 }), context);
		const polledAfterRename = await handleDelivery(
			instance,
			commented("poll-9", { pr: 7, comment: 501, login: "ana2" }),
			context,
		);
		expect([redelivered, polledAfterRename]).toStrictEqual([
			{ kind: "handled", requestId: "comment:501", fired: [] },
			{ kind: "handled", requestId: "comment:501", fired: [] },
		]);
		await settle();
		const { log, marking } = await instance.state(context);
		expect(log.map((entry) => entry.kind)).toStrictEqual([
			"ingress",
			"ingress",
			"occurrence",
			"ingress",
			"occurrence",
		]);
		expect(marking[replies.id]).toStrictEqual([{ repo, pr: 7, comment: 501 }]);
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
