// Planted defect: the marking and the occurrence log land in two commits, so a crash between them splits them.
import { fireStep } from "../../packages/petri-net/src/index.ts";
import type { Runtime, RuntimeOptions, Stepped } from "../../packages/runtime/src/index.ts";

export function createSplitCommitRuntime(options: RuntimeOptions): Runtime {
	let tail: Promise<unknown> = Promise.resolve();
	const stepNow = async (): Promise<Stepped> => {
		const state = await options.store.load();
		const step = fireStep(options.net, state.marking, options.policy);
		if (step.fired.length === 0) {
			return { fired: [], state };
		}
		await options.store.commit({ marking: step.marking, occurrences: state.occurrences });
		const at = options.clock.now();
		const fired = step.fired.map((element) => ({ ...element, at }));
		const next = { marking: step.marking, occurrences: [...state.occurrences, ...fired] };
		await options.store.commit(next);
		return { fired, state: next };
	};
	return {
		step: () => {
			const run = tail.then(stepNow);
			tail = run.catch(() => undefined);
			return run;
		},
	};
}
