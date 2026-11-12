import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineTask, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { definitionOrder } from "@petrus/petri-net";
import type { ExecutionInput, HandlerResult, NetInstance, Runtime } from "@petrus/runtime";
import { createRuntime, execution } from "@petrus/runtime";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { commits, Findings, initial, net, review, Work } from "./net.ts";
import type { ReviewFindings, ReviewWork } from "./net.ts";

export const context = BACKGROUND_CONTEXT;

export type Reviewer = (work: ReviewWork, context: Context) => ReviewFindings | Promise<ReviewFindings>;

export type Demo = {
	readonly runtime: Runtime;
	readonly instance: NetInstance;
	readonly admit: (revision: { readonly seq: number; readonly sha: string }) => Promise<void>;
	readonly runReady: () => Promise<void>;
	readonly moveTo: (time: number) => void;
	readonly close: () => Promise<void>;
};

/** Native sleeps make the scripted review finish only when the demo advances its clock. */
export async function openDemo(reviewer: Reviewer): Promise<Demo> {
	let time = 0;
	let quiet = Promise.withResolvers<undefined>();
	const task = defineTask<ExecutionInput, { readonly phase: "wait" | "review" }, HandlerResult>({
		name: "pr-review:review",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: ({ input }, rt, ctx) => rt.sleepUntil(input.startedAt + 10, { phase: "review" }, ctx),
			review: async ({ input }, rt, ctx) => {
				const { w } = Value.Parse(Type.Object({ w: Work }), input.binding);
				const value = Value.Parse(Findings, await reviewer(w, ctx));
				return rt.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: { variant: "reviewed", value } } }),
					ctx,
				);
			},
		},
		abort: (_task, rt, ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
	const runtime = createRuntime({
		name: "pr-review",
		nonce: randomUUID(),
		net,
		executions: [execution(review, task)],
		policy: definitionOrder,
		clock: { now: () => time },
		startLimit: 1000,
	});
	const registry = createRegistry();
	registry.install(runtime.extension);
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models: createModels(),
			registry,
			now: () => time,
			onWake: (wake) => {
				if (!wake.active) quiet.resolve(undefined);
			},
		},
		context,
	);
	const instance = runtime.instance(harness, (await harness.root(context)).id);
	await instance.enqueue({ requestId: "initial", tokens: initial }, context);
	return {
		runtime,
		instance,
		admit: async ({ seq, sha }) => {
			await instance.enqueue(
				{ requestId: `commit:${String(seq)}`, tokens: { [commits.id]: [{ seq, sha }] } },
				context,
			);
		},
		runReady: async () => {
			quiet = Promise.withResolvers<undefined>();
			harness.resume();
			if (harness.wake().active) await quiet.promise;
		},
		moveTo: (next) => {
			time = next;
		},
		close: () => harness.close(context),
	};
}
