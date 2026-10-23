import type { NotEnabled, Result, Transition, TransitionId } from "@petrus/petri-net";
import { err, fire, netProblems, ok } from "@petrus/petri-net";
import type { InstanceState, InstanceStore } from "./instance.ts";
import type { Clock } from "./seams.ts";
import { createSerialQueue } from "./serial-queue.ts";

/** The step named a transition that is not in the net. */
export type UnknownTransition = { readonly kind: "unknown-transition"; readonly transition: TransitionId };

/** The expected ways a step can fail. A store failure is not one of them: it throws. */
export type StepFailure = NotEnabled | UnknownTransition;

/** One running net instance. */
export type Runtime = {
	/** Fires one transition and commits the new marking and its occurrence together. Steps run one at a time. */
	readonly step: (transition: TransitionId) => Promise<Result<InstanceState, StepFailure>>;
};

/** What a runtime needs: the net, the store of its instance, and the clock that stamps occurrences. */
export type RuntimeOptions = {
	readonly transitions: readonly Transition[];
	readonly store: InstanceStore;
	readonly clock: Clock;
};

/** Builds a runtime for one instance. A net with problems (see `netProblems`) is a bug, so it throws. */
export function createRuntime(options: RuntimeOptions): Runtime {
	const { transitions, store, clock } = options;
	const problems = netProblems(transitions);
	if (problems.length > 0) {
		throw new Error(`invalid net: ${problems.join("; ")}`);
	}
	const byId = new Map(transitions.map((transition) => [transition.id, transition]));
	const serial = createSerialQueue();

	async function stepNow(id: TransitionId): Promise<Result<InstanceState, StepFailure>> {
		const transition = byId.get(id);
		if (transition === undefined) {
			return err({ kind: "unknown-transition", transition: id });
		}
		const state = await store.load();
		const fired = fire(transition, state.marking);
		if (!fired.ok) {
			return fired;
		}
		const next: InstanceState = {
			marking: fired.value,
			occurrences: [...state.occurrences, { transition: id, at: clock.now() }],
		};
		await store.commit(next);
		return ok(next);
	}

	return { step: (id) => serial(() => stepNow(id)) };
}
