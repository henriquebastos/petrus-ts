import type { Net, SelectionPolicy } from "@petrus/petri-net";
import { fireStep } from "@petrus/petri-net";
import type { NetInstanceState, Occurrence } from "./net-instance.ts";

/** What one step fired: its occurrences, in firing order, and the state after it. */
export type Stepped = { readonly fired: readonly Occurrence[]; readonly state: NetInstanceState };

/**
 * The pure part of a step: fire what the policy selects, stamp each occurrence with `at`, and append the
 * occurrences to the log. When nothing fires it returns the same state, so the caller can skip the commit.
 */
export function advance(net: Net, policy: SelectionPolicy, state: NetInstanceState, at: number): Stepped {
	const step = fireStep(net, state.marking, policy);
	if (step.fired.length === 0) {
		return { fired: [], state };
	}
	const fired = step.fired.map(({ transition, binding }) => ({ transition, binding, at }));
	return { fired, state: { marking: step.marking, occurrences: [...state.occurrences, ...fired] } };
}
