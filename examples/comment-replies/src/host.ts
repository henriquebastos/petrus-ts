import type { Context } from "@earendil-works/chord";
import type { NetInstance, Occurrence } from "@petrus/runtime";
import type { Delivery } from "./deliveries.ts";
import { toBatch } from "./deliveries.ts";

export type Handled =
	| { readonly kind: "handled"; readonly requestId: string; readonly fired: readonly Occurrence[] }
	| { readonly kind: "ignored"; readonly reason: string };

/**
 * Adds a delivery's batch. The enqueue steps the net until nothing fires, in the commit that adds the batch, and
 * `fired` is what those steps fired. It is safe to call again with the same delivery, for example after a crash or a
 * lost reply: the enqueue adds nothing and fires nothing.
 */
export async function handleDelivery(instance: NetInstance, delivery: Delivery, context: Context): Promise<Handled> {
	const translated = toBatch(delivery);
	if (translated.kind === "ignored") {
		return translated;
	}
	const { fired } = await instance.enqueue(translated.batch, context);
	return { kind: "handled", requestId: translated.batch.requestId, fired };
}
