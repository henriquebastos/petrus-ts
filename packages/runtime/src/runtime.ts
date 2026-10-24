import type { Binding, Net, NotABinding, NotEnabled, Result, TransitionId } from "@petrus/petri-net";
import { err, fire, markingProblems, netProblems, ok } from "@petrus/petri-net";
import type { NetInstanceState, NetInstanceStore } from "./net-instance.ts";
import type { Clock } from "./seams.ts";
import { createSerialQueue } from "./serial-queue.ts";

/** The step named a transition that is not in the net. */
export type UnknownTransition = { readonly kind: "unknown-transition"; readonly transition: TransitionId };

/** The expected ways a step can fail. A store failure is not one of them: it throws. */
export type StepFailure = NotABinding | NotEnabled | UnknownTransition;

/** One running net instance. */
export type Runtime = {
	/**
	 * Fires one binding element and commits the new marking and its occurrence together. Steps run one at a time.
	 */
	readonly step: (transition: TransitionId, binding: Binding) => Promise<Result<NetInstanceState, StepFailure>>;
};

/** What a runtime needs: the net, the store of its net instance, and the clock that stamps occurrences. */
export type RuntimeOptions = {
	readonly net: Net;
	readonly store: NetInstanceStore;
	readonly clock: Clock;
};

/**
 * Builds a runtime for one net instance. A net with problems (see `netProblems`) is a bug, so it throws.
 * A stored marking with problems (see `markingProblems`) is a bug too: the step rejects.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
	const { net, store, clock } = options;
	const problems = netProblems(net);
	if (problems.length > 0) {
		throw new Error(`invalid net: ${problems.join("; ")}`);
	}
	const byId = new Map(net.transitions.map((transition) => [transition.id, transition]));
	const serial = createSerialQueue();

	async function load(): Promise<NetInstanceState> {
		const state = await store.load();
		const wrong = markingProblems(net, state.marking);
		if (wrong.length > 0) {
			throw new Error(`invalid stored marking: ${wrong.join("; ")}`);
		}
		return state;
	}

	async function stepNow(id: TransitionId, binding: Binding): Promise<Result<NetInstanceState, StepFailure>> {
		const transition = byId.get(id);
		if (transition === undefined) {
			return err({ kind: "unknown-transition", transition: id });
		}
		const state = await load();
		const fired = fire(transition, binding, state.marking);
		if (!fired.ok) {
			return fired;
		}
		const next: NetInstanceState = {
			marking: fired.value,
			occurrences: [...state.occurrences, { transition: id, binding, at: clock.now() }],
		};
		await store.commit(next);
		return ok(next);
	}

	return { step: (id, binding) => serial(() => stepNow(id, binding)) };
}
