import type { Net, SelectionPolicy } from "@petrus/petri-net";
import { fireStep, markingProblems, netProblems } from "@petrus/petri-net";
import type { NetInstanceState, NetInstanceStore, Occurrence } from "./net-instance.ts";
import type { Clock } from "./seams.ts";
import { createSerialQueue } from "./serial-queue.ts";

/** What one step committed: its occurrences, in firing order, and the state after it. */
export type Stepped = { readonly fired: readonly Occurrence[]; readonly state: NetInstanceState };

/** One running net instance. */
export type Runtime = {
	/**
	 * Selects a step with the policy, fires it, and commits the new marking and its occurrences together.
	 * When nothing is enabled it fires nothing and commits nothing. Steps run one at a time.
	 */
	readonly step: () => Promise<Stepped>;
};

/**
 * What a runtime needs: the net, the store of its net instance, the policy that orders and filters the enabled
 * binding elements, and the clock that stamps occurrences.
 */
export type RuntimeOptions = {
	readonly net: Net;
	readonly store: NetInstanceStore;
	readonly policy: SelectionPolicy;
	readonly clock: Clock;
};

/**
 * Builds a runtime for one net instance. A net with problems (see `netProblems`) is a bug, so it throws.
 * A stored marking with problems (see `markingProblems`) is a bug too: the step rejects.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
	const { net, store, policy, clock } = options;
	const problems = netProblems(net);
	if (problems.length > 0) {
		throw new Error(`invalid net: ${problems.join("; ")}`);
	}
	const serial = createSerialQueue();

	async function load(): Promise<NetInstanceState> {
		const state = await store.load();
		const wrong = markingProblems(net, state.marking);
		if (wrong.length > 0) {
			throw new Error(`invalid stored marking: ${wrong.join("; ")}`);
		}
		return state;
	}

	async function stepNow(): Promise<Stepped> {
		const state = await load();
		const step = fireStep(net, state.marking, policy);
		if (step.fired.length === 0) {
			return { fired: [], state };
		}
		const at = clock.now();
		const fired = step.fired.map(({ transition, binding }) => ({ transition, binding, at }));
		const next: NetInstanceState = { marking: step.marking, occurrences: [...state.occurrences, ...fired] };
		await store.commit(next);
		return { fired, state: next };
	}

	return { step: () => serial(stepNow) };
}
