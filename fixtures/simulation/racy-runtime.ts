// Planted defect: steps do not wait for each other, so two steps can read the same marking.
import type { Runtime, RuntimeOptions, Stepped } from "../../packages/runtime/src/index.ts";
import { advance } from "../../packages/runtime/src/advance.ts";

export function createRacyRuntime(options: RuntimeOptions): Runtime {
	return {
		step: async (): Promise<Stepped> => {
			const stepped = advance(options.net, options.policy, await options.store.load(), options.clock.now());
			await options.store.commit(stepped.state);
			return stepped;
		},
	};
}
