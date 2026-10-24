// Runs the app over delivery files: node examples/comment-replies/src/main.ts <state.json> <delivery.json>...
// It is the composition root: the only file that reads the system clock and process arguments.
import { readFile } from "node:fs/promises";
import { definitionOrder } from "@petrus/petri-net";
import { createRuntime } from "@petrus/runtime";
import { Value } from "typebox/value";
import { Delivery } from "./deliveries.ts";
import { createFileStore } from "./file-store.ts";
import { handleDelivery } from "./host.ts";
import { net } from "./net.ts";

const [statePath, ...deliveryPaths] = process.argv.slice(2);
if (statePath === undefined) {
	throw new Error("usage: main.ts <state.json> <delivery.json>...");
}
const store = createFileStore(statePath, { marking: {}, log: [] });
// eslint-disable-next-line no-restricted-properties -- the composition root makes the clock that the runtime takes
const clock = { now: () => Date.now() };
const runtime = createRuntime({ net, store, policy: definitionOrder, clock });

for (const path of deliveryPaths) {
	const delivery = Value.Parse(Delivery, JSON.parse(await readFile(path, "utf8")));
	const handled = await handleDelivery(runtime, delivery);
	const summary = handled.kind === "ignored" ? `ignored: ${handled.reason}` : `fired ${String(handled.fired.length)}`;
	console.log(`${delivery.id} ${summary}`);
}
console.log(JSON.stringify((await store.load()).marking));
