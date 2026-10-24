// Planted defect: steps report what they fired but never commit, so the store keeps its initial state.
import { fireStep } from "../../packages/petri-net/src/index.ts";
import type { Runtime, RuntimeOptions, Stepped } from "../../packages/runtime/src/index.ts";

export function createForgetfulRuntime(options: RuntimeOptions): Runtime {
	return {
		step: async (): Promise<Stepped> => {
			const state = await options.store.load();
			const step = fireStep(options.net, state.marking, options.policy);
			const at = options.clock.now();
			const fired = step.fired.map((element) => ({ ...element, at }));
			return { fired, state: { marking: step.marking, occurrences: [...state.occurrences, ...fired] } };
		},
	};
}
