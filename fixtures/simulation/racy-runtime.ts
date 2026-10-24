// Planted defect: steps do not wait for each other, so two steps can read the same marking.
import { fireStep } from "../../packages/petri-net/src/index.ts";
import type { Runtime, RuntimeOptions, Stepped } from "../../packages/runtime/src/index.ts";

export function createRacyRuntime(options: RuntimeOptions): Runtime {
	return {
		step: async (): Promise<Stepped> => {
			const state = await options.store.load();
			const step = fireStep(options.net, state.marking, options.policy);
			const at = options.clock.now();
			const fired = step.fired.map((element) => ({ ...element, at }));
			const next = { marking: step.marking, occurrences: [...state.occurrences, ...fired] };
			await options.store.commit(next);
			return { fired, state: next };
		},
	};
}
