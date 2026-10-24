// Runs the app over delivery files: node examples/comment-replies/src/main.ts <state-dir> <delivery.json>...
// It is the composition root: the only file that reads the system clock and process arguments.
import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { definitionOrder } from "@petrus/petri-net";
import { createRuntime } from "@petrus/runtime";
import { Value } from "typebox/value";
import { Delivery } from "./deliveries.ts";
import { handleDelivery } from "./host.ts";
import { net } from "./net.ts";

const [stateDirectory, ...deliveryPaths] = process.argv.slice(2);
if (stateDirectory === undefined) {
	throw new Error("usage: main.ts <state-dir> <delivery.json>...");
}
const context = BACKGROUND_CONTEXT;
// eslint-disable-next-line no-restricted-properties -- the composition root makes the clock that the runtime takes
const clock = { now: () => Date.now() };
// The net has no handler transitions, so no operation runs and the retry delay never applies.
const runtime = createRuntime({ name: "comment-replies", net, policy: definitionOrder, clock, retryDelayMs: 1_000 });
const registry = createRegistry();
registry.install(runtime.extension);
// With fsync a power loss leaves whole commits only. Durable's JSONL storage (1.4.0) does not flush the marker, so
// the last acknowledged commits can still be lost.
const storage = await openNodeJsonlStorage(stateDirectory, context, { fsync: true });
const harness = await Harness.open(storage, { models: createModels(), registry, now: clock.now }, context);
try {
	const instance = runtime.instance(harness, (await harness.root(context)).id);
	for (const path of deliveryPaths) {
		const delivery = Value.Parse(Delivery, JSON.parse(await readFile(path, "utf8")));
		const handled = await handleDelivery(instance, delivery, context);
		const summary =
			handled.kind === "ignored" ? `ignored: ${handled.reason}` : `fired ${String(handled.fired.length)}`;
		console.log(`${delivery.id} ${summary}`);
	}
	console.log(JSON.stringify((await instance.state(context)).marking));
} finally {
	await harness.close(context);
}
