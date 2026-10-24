import type { Net, SelectionPolicy } from "@petrus/petri-net";
import { markingProblems, netProblems } from "@petrus/petri-net";
import type { Stepped } from "./advance.ts";
import { advance } from "./advance.ts";
import type { NetInstanceState, NetInstanceStore } from "./net-instance.ts";
import type { Clock } from "./seams.ts";
import { createSerialQueue } from "./serial-queue.ts";

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
		const stepped = advance(net, policy, state, clock.now());
		if (stepped.state !== state) {
			await store.commit(stepped.state);
		}
		return stepped;
	}

	return { step: () => serial(stepNow) };
}
