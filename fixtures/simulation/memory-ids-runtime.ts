// Planted defect: enqueue looks request ids up in memory, filled before the commit, instead of in the stored log.
// A new runtime forgets them, and a failed commit leaves an id that names tokens the store never got.
import { addTokens, placeId } from "../../packages/petri-net/src/index.ts";
import type { Batch, Ingress, Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime } from "../../packages/runtime/src/runtime.ts";

export function createMemoryIdsRuntime(options: RuntimeOptions): Runtime {
	const seen = new Map<string, Ingress>();
	return {
		...createRuntime(options),
		enqueue: async (batch: Batch): Promise<Ingress> => {
			const known = seen.get(batch.requestId);
			if (known !== undefined) {
				return known;
			}
			const state = await options.store.load();
			const ingress: Ingress = { kind: "ingress", ...batch, at: options.clock.now() };
			seen.set(batch.requestId, ingress);
			const marking = Object.entries(batch.tokens).reduce(
				(sum, [place, tokens]) => addTokens(sum, placeId(place), tokens),
				state.marking,
			);
			await options.store.commit({ marking, log: [...state.log, ingress] });
			return ingress;
		},
	};
}
