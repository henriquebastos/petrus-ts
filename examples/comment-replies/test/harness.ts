import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import type { Storage } from "@earendil-works/pi-durable";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { definitionOrder } from "@petrus/petri-net";
import type { NetInstance } from "@petrus/runtime";
import { createRuntime } from "@petrus/runtime";
import { net } from "../src/net.ts";

/** The context of every Durable call in the tests. */
export const context: Context = BACKGROUND_CONTEXT;

/** One process of the app: the net instance in the root conversation of its Harness, and the Harness's close. */
export type Opened = {
	readonly instance: NetInstance;
	readonly settle: () => Promise<void>;
	readonly close: () => Promise<void>;
};

/** A new Harness over `storage` with the runtime of the net, as `src/main.ts` opens it, at a clock that stands still. */
export async function openInstance(storage: Storage): Promise<Opened> {
	const clock = { now: () => 1 };
	const runtime = createRuntime({
		name: "comment-replies",
		nonce: randomUUID(),
		net,
		policy: definitionOrder,
		clock,
		startLimit: 10_000,
	});
	const registry = createRegistry();
	registry.install(runtime.extension);
	const harness = await Harness.open(storage, { models: createModels(), registry, now: clock.now }, context);
	const root = await harness.root(context);
	return {
		instance: runtime.instance(harness, root.id),
		settle: () => harness.waitForIdle(context),
		close: () => harness.close(context),
	};
}
