import { expect, test } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { opusReviewer } from "../src/opus.ts";
import { recordReview } from "../src/record.ts";
import { context } from "../src/run.ts";
import { snapshots } from "../src/snapshots.ts";

function reply(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		timestamp: 0,
		stopReason,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

const models = createModels();
models.setProvider(anthropicProvider());

test("Opus reviews selected snapshots with prior findings and settles validated reports", async () => {
	const prompts: Context[] = [];
	const finding = { id: "cross-tenant", note: "An administrator can read another tenant's document." };
	const run = opusReviewer({
		getModel: models.getModel.bind(models),
		completeSimple: (model, prompt) => {
			expect(model.id).toBe("claude-opus-5-5");
			prompts.push(prompt);
			return Promise.resolve(reply(JSON.stringify(prompts.length === 1 ? [finding] : [])));
		},
	});
	const recording = await recordReview("skip-b", { run, source: "Typed model fake" });
	expect(prompts.map(({ messages }) => messages[0]?.content)).toStrictEqual([
		JSON.stringify({ snapshot: snapshots[0], memory: { reviewedSeq: 0, findings: [] } }),
		JSON.stringify({ snapshot: snapshots[2], memory: { reviewedSeq: 1, findings: [finding] } }),
	]);
	expect(recording.committedMarking.Reports).toStrictEqual([
		{ seq: 1, sha: snapshots[0].sha, findings: [finding] },
		{ seq: 3, sha: snapshots[2].sha, findings: [] },
	]);
});

test.each([
	["not JSON", "stop"],
	["{}", "stop"],
	['[{"id":"missing-note"}]', "stop"],
	['[{"id":123,"note":"wrong id type"}]', "stop"],
	["[]", "length"],
	["[]", "error"],
	["[]", "aborted"],
] as const)("rejects model response %s ending with %s", async (text, stopReason) => {
	const review = opusReviewer({
		getModel: models.getModel.bind(models),
		completeSimple: () => Promise.resolve(reply(text, stopReason)),
	});
	await expect(review({ c: snapshots[0], m: { reviewedSeq: 0, findings: [] } }, context)).rejects.toThrow();
});
