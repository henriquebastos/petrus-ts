// Planted defect: the queue lets the next step run as soon as this step issued its commit, not when the commit landed.
import { fireStep } from "../../packages/petri-net/src/index.ts";
import type { Runtime, RuntimeOptions, Stepped } from "../../packages/runtime/src/index.ts";
import { createSerialQueue } from "../../packages/runtime/src/serial-queue.ts";

type Prepared = { readonly stepped: Stepped; readonly landed: Promise<void> };

export function createEarlyReleaseRuntime(options: RuntimeOptions): Runtime {
	const serial = createSerialQueue();

	async function prepare(): Promise<Prepared> {
		const state = await options.store.load();
		const step = fireStep(options.net, state.marking, options.policy);
		const at = options.clock.now();
		const fired = step.fired.map((element) => ({ ...element, at }));
		const next = { marking: step.marking, occurrences: [...state.occurrences, ...fired] };
		return { stepped: { fired, state: next }, landed: options.store.commit(next) };
	}

	return {
		step: async (): Promise<Stepped> => {
			const prepared = await serial(prepare);
			await prepared.landed;
			return prepared.stepped;
		},
	};
}
