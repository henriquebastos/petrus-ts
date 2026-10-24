// Planted defect: enqueue ignores the request id, so a retry after a lost reply adds the batch a second time.
import { addTokens, placeId } from "../../packages/petri-net/src/index.ts";
import type { Batch, Ingress, Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime } from "../../packages/runtime/src/runtime.ts";

export function createIdBlindRuntime(options: RuntimeOptions): Runtime {
	return {
		...createRuntime(options),
		enqueue: async (batch: Batch): Promise<Ingress> => {
			const state = await options.store.load();
			const ingress: Ingress = { kind: "ingress", ...batch, at: options.clock.now() };
			const marking = Object.entries(batch.tokens).reduce(
				(sum, [place, tokens]) => addTokens(sum, placeId(place), tokens),
				state.marking,
			);
			await options.store.commit({ marking, log: [...state.log, ingress] });
			return ingress;
		},
	};
}
