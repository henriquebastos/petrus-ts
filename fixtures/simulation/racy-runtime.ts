// Planted defect: steps do not wait for each other, so two steps can read the same marking.
import type { Binding, Result, TransitionId } from "../../packages/petri-net/src/index.ts";
import { err, fire, ok } from "../../packages/petri-net/src/index.ts";
import type { NetInstanceState, Runtime, RuntimeOptions, StepFailure } from "../../packages/runtime/src/index.ts";

export function createRacyRuntime(options: RuntimeOptions): Runtime {
	return {
		step: async (id: TransitionId, binding: Binding): Promise<Result<NetInstanceState, StepFailure>> => {
			const transition = options.net.transitions.find((candidate) => candidate.id === id);
			if (transition === undefined) {
				return err({ kind: "unknown-transition", transition: id });
			}
			const state = await options.store.load();
			const fired = fire(transition, binding, state.marking);
			if (!fired.ok) {
				return fired;
			}
			const next = {
				marking: fired.value,
				occurrences: [...state.occurrences, { transition: id, binding, at: options.clock.now() }],
			};
			await options.store.commit(next);
			return ok(next);
		},
	};
}
