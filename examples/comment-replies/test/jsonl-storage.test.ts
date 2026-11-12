import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { NetInstanceState } from "@petrus/runtime";
import { describe, expect, onTestFinished, test } from "vitest";
import type { Delivery } from "../src/deliveries.ts";
import { handleDelivery } from "../src/host.ts";
import type { Opened } from "./harness.ts";
import { context, openInstance } from "./harness.ts";

const comment: Delivery = {
	id: "d2",
	event: "issue_comment",
	payload: {
		action: "created",
		repository: { id: 4001 },
		issue: { number: 7, pull_request: {} },
		comment: { id: 501, user: { id: 91 } },
	},
};

const opened: Delivery = {
	id: "d1",
	event: "pull_request",
	payload: { action: "opened", repository: { id: 4001 }, pull_request: { number: 7 } },
};

/** A new Harness over the JSONL storage in `directory`, as a new process of `src/main.ts` opens it. */
async function openOver(directory: string): Promise<Opened> {
	return openInstance(await openNodeJsonlStorage(directory, context));
}

/** Handles the deliveries in a first process, closes it, and returns the state it committed. */
async function firstProcess(directory: string): Promise<NetInstanceState> {
	const { instance, close, settle } = await openOver(directory);
	try {
		await handleDelivery(instance, opened, context);
		await handleDelivery(instance, comment, context);
		await settle();
		return await instance.state(context);
	} finally {
		await close();
	}
}

describe("a Harness over JSONL storage", () => {
	test("reopen settles an admitted reply once without resetting its start budget", async () => {
		const directory = join(mkdtempSync(join(tmpdir(), "comment-replies-")), "state");
		const first = await openOver(directory);
		await handleDelivery(first.instance, opened, context);
		await handleDelivery(first.instance, comment, context);
		expect(await first.instance.inFlight(context)).toHaveLength(1);
		const admitted = await first.instance.state(context);
		await first.close();
		const second = await openOver(directory);
		onTestFinished(second.close);
		expect(await second.instance.state(context)).toStrictEqual(admitted);
		await handleDelivery(second.instance, comment, context);
		await second.settle();
		expect(await second.instance.inFlight(context)).toStrictEqual([]);
		expect(await second.instance.budget(context)).toStrictEqual({ ceiling: 10_000, used: 1, paused: false });
		const settled = await second.instance.state(context);
		expect(
			settled.log.filter((entry) => entry.kind === "ingress" && entry.requestId.startsWith("result:")),
		).toHaveLength(1);
		expect(settled.marking).toStrictEqual({
			replies: [{ repo: 4001, pr: 7, comment: 501 }],
			free: [{ repo: 4001, pr: 7 }],
		});
	});

	test("a new Harness over the same JSONL directory reads what the last commit wrote", async () => {
		const directory = join(mkdtempSync(join(tmpdir(), "comment-replies-")), "state");
		const committed = await firstProcess(directory);
		expect(committed.log.map((entry) => entry.kind)).toStrictEqual([
			"ingress",
			"ingress",
			"occurrence",
			"ingress",
			"occurrence",
		]);
		const { instance, close } = await openOver(directory);
		onTestFinished(close);
		expect(await instance.state(context)).toStrictEqual(committed);
	});

	test("the same delivery sent again on the new Harness adds nothing", async () => {
		const directory = join(mkdtempSync(join(tmpdir(), "comment-replies-")), "state");
		const committed = await firstProcess(directory);
		const { instance, close } = await openOver(directory);
		onTestFinished(close);
		expect(await handleDelivery(instance, comment, context)).toStrictEqual({
			kind: "handled",
			requestId: "comment:501",
			fired: [],
		});
		expect(await instance.state(context)).toStrictEqual(committed);
	});
});
