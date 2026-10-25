import type { Marking, Net, SelectionPolicy } from "@petrus/petri-net";
import { fireStep } from "@petrus/petri-net";
import type { Occurrence } from "./net-instance.ts";

/** What one step fired: its occurrences, in firing order, and the marking after it. */
export type Stepped = { readonly fired: readonly Occurrence[]; readonly marking: Marking };

/**
 * The pure part of a step: fire what the policy selects, and stamp each occurrence with `at`. When nothing fires it
 * returns the same marking, so the caller can skip the commit.
 */
export function advance(net: Net, policy: SelectionPolicy, marking: Marking, at: number): Stepped {
	const step = fireStep(net, marking, policy);
	const fired = step.fired.map(({ transition, binding }) => ({
		kind: "occurrence" as const,
		transition,
		binding,
		at,
	}));
	return { fired, marking: step.marking };
}

/** The most steps that one commit fires. A net that still fires after them would hold the Session line for ever. */
export const stepLimit = 1_000;

/**
 * Steps until the policy selects nothing, so that every commit leaves the net quiet. It returns every occurrence, in
 * firing order, and the marking after the last step. A net that fires `stepLimit` steps and can still fire is a bug in
 * the net, so it throws.
 */
export function advanceUntilQuiet(net: Net, policy: SelectionPolicy, marking: Marking, at: number): Stepped {
	const fired: Occurrence[] = [];
	let current = marking;
	for (let steps = 0; ; steps += 1) {
		const stepped = advance(net, policy, current, at);
		if (stepped.fired.length === 0) {
			return { fired, marking: current };
		}
		if (steps === stepLimit) {
			throw new Error(`the net did not become quiet after ${String(stepLimit)} steps`);
		}
		fired.push(...stepped.fired);
		current = stepped.marking;
	}
}
