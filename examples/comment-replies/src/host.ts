import type { Occurrence, Runtime } from "@petrus/runtime";
import type { Delivery } from "./deliveries.ts";
import { toBatch } from "./deliveries.ts";

export type Handled =
	| { readonly kind: "handled"; readonly requestId: string; readonly fired: readonly Occurrence[] }
	| { readonly kind: "ignored"; readonly reason: string };

/**
 * Adds a delivery's batch, then steps until nothing fires. It is safe to call again with the same delivery, for
 * example after a crash or a lost reply: the enqueue adds nothing, and the steps go on from the stored state.
 */
export async function handleDelivery(runtime: Runtime, delivery: Delivery): Promise<Handled> {
	const translated = toBatch(delivery);
	if (translated.kind === "ignored") {
		return translated;
	}
	await runtime.enqueue(translated.batch);
	return { kind: "handled", requestId: translated.batch.requestId, fired: await settle(runtime) };
}

/** Steps until a step fires nothing. This net always stops; a host whose net can cycle must also count steps. */
async function settle(runtime: Runtime): Promise<readonly Occurrence[]> {
	const fired: Occurrence[] = [];
	for (let stepped = await runtime.step(); stepped.fired.length > 0; stepped = await runtime.step()) {
		fired.push(...stepped.fired);
	}
	return fired;
}
