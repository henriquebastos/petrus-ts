// Planted defect: enqueue does not wait for the steps, so an enqueue and a step can read the same state.
import type { Batch, Ingress, Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { admit } from "../../packages/runtime/src/admit.ts";
import { createRuntime } from "../../packages/runtime/src/runtime.ts";

export function createUnqueuedEnqueueRuntime(options: RuntimeOptions): Runtime {
	return {
		...createRuntime(options),
		enqueue: async (batch: Batch): Promise<Ingress> => {
			const admitted = admit(options.net, await options.store.load(), batch, options.clock.now());
			if (admitted.kind === "applied") {
				await options.store.commit(admitted.state);
			}
			return admitted.ingress;
		},
	};
}
