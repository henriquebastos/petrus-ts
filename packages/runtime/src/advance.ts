import type { IndexedMarking, SelectionPolicy } from "@petrus/petri-net";
import { stepIndexed } from "@petrus/petri-net";
import type { Occurrence } from "./net-instance.ts";
import { BrokenNetInstance } from "./net-instance.ts";

/** What one step fired: its occurrences, in firing order, and the marking after it. */
export type Stepped = { readonly fired: readonly Occurrence[]; readonly indexed: IndexedMarking };

/**
 * Fires what the policy selects and stamps each occurrence with `at`. Consumes the index even when nothing fires.
 */
export function advance(policy: SelectionPolicy, indexed: IndexedMarking, at: number): Stepped {
	const step = stepIndexed(indexed, policy);
	const fired = step.fired.map(({ transition, binding }) => ({
		kind: "occurrence" as const,
		transition,
		binding,
		at,
	}));
	return { fired, indexed: step.indexed };
}

/** The most steps that one commit fires. A net that still fires after them would hold the Session line for ever. */
export const stepLimit = 1_000;

/**
 * Steps until the policy selects nothing, so that every commit leaves the net quiet. It returns every occurrence, in
 * firing order, and the marking after the last step. A net that fires `stepLimit` steps and can still fire is a bug in
 * the net, so it throws.
 */
export function advanceUntilQuiet(policy: SelectionPolicy, indexed: IndexedMarking, at: number): Stepped {
	const fired: Occurrence[] = [];
	let current = indexed;
	for (let steps = 0; ; steps += 1) {
		const stepped = advance(policy, current, at);
		if (stepped.fired.length === 0) {
			return { fired, indexed: stepped.indexed };
		}
		if (steps === stepLimit) {
			throw new BrokenNetInstance(`the net did not become quiet after ${String(stepLimit)} steps`);
		}
		fired.push(...stepped.fired);
		current = stepped.indexed;
	}
}
