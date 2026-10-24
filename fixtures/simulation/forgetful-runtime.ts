// Planted defect: steps report success but never commit, so the store keeps its initial state.
import type { Binding, Result, TransitionId } from "../../packages/petri-net/src/index.ts";
import { err, fire, ok } from "../../packages/petri-net/src/index.ts";
import type { NetInstanceState, Runtime, RuntimeOptions, StepFailure } from "../../packages/runtime/src/index.ts";

export function createForgetfulRuntime(options: RuntimeOptions): Runtime {
	return {
		step: async (id: TransitionId, binding: Binding): Promise<Result<NetInstanceState, StepFailure>> => {
			const transition = options.net.transitions.find((candidate) => candidate.id === id);
			if (transition === undefined) {
				return err({ kind: "unknown-transition", transition: id });
			}
			const state = await options.store.load();
			const fired = fire(transition, binding, state.marking);
			return fired.ok ? ok({ marking: fired.value, occurrences: state.occurrences }) : fired;
		},
	};
}
