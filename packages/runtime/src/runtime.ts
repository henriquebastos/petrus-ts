import type { NotEnabled, Result, Transition, TransitionId } from "@petrus/net";
import { err, fire, ok } from "@petrus/net";
import type { InstanceState, InstanceStore } from "./instance.ts";
import type { Clock } from "./seams.ts";
import { createSerialQueue } from "./serial-queue.ts";

export type UnknownTransition = { readonly kind: "unknown-transition"; readonly transition: TransitionId };

export type StepFailure = NotEnabled | UnknownTransition;

export type Runtime = {
	/** Fires one transition and commits the new marking and its occurrence together. Steps run one at a time. */
	readonly step: (transition: TransitionId) => Promise<Result<InstanceState, StepFailure>>;
};

export type RuntimeOptions = {
	readonly transitions: readonly Transition[];
	readonly store: InstanceStore;
	readonly clock: Clock;
};

export function createRuntime(options: RuntimeOptions): Runtime {
	const { transitions, store, clock } = options;
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
