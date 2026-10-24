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
	const fired = step.fired.map(({ transition, binding }) => ({
		kind: "occurrence" as const,
		transition,
		binding,
		at,
	}));
	return { fired, state: { marking: step.marking, log: [...state.log, ...fired] } };
}

/** The most steps that one commit fires. A net that still fires after them would hold the Session line for ever. */
export const stepLimit = 1_000;

/**
 * Steps until the policy selects nothing, so that every commit leaves the net quiet. It returns every occurrence, in
 * firing order, and the state after the last step. A net that fires `stepLimit` steps and can still fire is a bug in
 * the net, so it throws.
 */
export function advanceUntilQuiet(net: Net, policy: SelectionPolicy, state: NetInstanceState, at: number): Stepped {
	const fired: Occurrence[] = [];
	let current = state;
	for (let steps = 0; ; steps += 1) {
		const stepped = advance(net, policy, current, at);
		if (stepped.fired.length === 0) {
			return { fired, state: current };
		}
		if (steps === stepLimit) {
			throw new Error(`the net did not become quiet after ${String(stepLimit)} steps`);
		}
		fired.push(...stepped.fired);
		current = stepped.state;
	}
}
