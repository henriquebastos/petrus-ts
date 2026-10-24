// Planted defect: the queue lets the next step run as soon as this step issued its commit, not when the commit landed.
import type { Runtime, RuntimeOptions, Stepped } from "../../packages/runtime/src/index.ts";
import { advance } from "../../packages/runtime/src/advance.ts";
import { createRuntime } from "../../packages/runtime/src/runtime.ts";
import { createSerialQueue } from "../../packages/runtime/src/serial-queue.ts";

type Prepared = { readonly stepped: Stepped; readonly landed: Promise<void> };

export function createEarlyReleaseRuntime(options: RuntimeOptions): Runtime {
	const serial = createSerialQueue();

	async function prepare(): Promise<Prepared> {
		const stepped = advance(options.net, options.policy, await options.store.load(), options.clock.now());
		return { stepped, landed: options.store.commit(stepped.state) };
	}

	return {
		...createRuntime(options),
		step: async (): Promise<Stepped> => {
			const prepared = await serial(prepare);
			await prepared.landed;
			return prepared.stepped;
		},
	};
}
