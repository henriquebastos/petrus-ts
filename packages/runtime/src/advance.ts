import type { IndexedMarking, SelectionPolicy, TransitionId } from "@petrus/petri-net";
import { enabledElementsIndexed, stepIndexed } from "@petrus/petri-net";
import type { Occurrence, StartBudget } from "./net-instance.ts";
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
	return untilQuiet(indexed, (current) => advance(policy, current, at));
}

/** Internal ends settle before authored allocation, including while the durable start budget is paused. */
export function advanceOperations(
	policy: SelectionPolicy,
	indexed: IndexedMarking,
	at: number,
	authored: ReadonlySet<TransitionId>,
	budget: StartBudget,
): Stepped & { readonly budget: StartBudget } {
	let used = budget.used;
	let paused = budget.paused;
	const stepped = untilQuiet(indexed, (current) => {
		const ends = enabledElementsIndexed(current).filter((element) => !authored.has(element.transition));
		if (ends.length > 0) {
			return advance(() => ends, current, at);
		}
		const step = stepIndexed(current, paused ? () => [] : policy, budget.ceiling - used);
		used += step.fired.length;
		paused ||= step.limited;
		return {
			indexed: step.indexed,
			fired: step.fired.map((element) => ({ ...element, kind: "occurrence", at })),
		};
	});
	return { ...stepped, budget: { ceiling: budget.ceiling, used, paused } };
}

function untilQuiet(indexed: IndexedMarking, step: (current: IndexedMarking) => Stepped): Stepped {
	const fired: Occurrence[] = [];
	let current = indexed;
	for (let steps = 0; ; steps += 1) {
		const stepped = step(current);
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
