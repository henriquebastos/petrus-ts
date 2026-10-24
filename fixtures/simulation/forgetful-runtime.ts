// Planted defect: steps report what they fired but never commit, so the store keeps its initial state.
import type { Runtime, RuntimeOptions, Stepped } from "../../packages/runtime/src/index.ts";
import { advance } from "../../packages/runtime/src/advance.ts";

export function createForgetfulRuntime(options: RuntimeOptions): Runtime {
	return {
		step: async (): Promise<Stepped> =>
			advance(options.net, options.policy, await options.store.load(), options.clock.now()),
	};
}
