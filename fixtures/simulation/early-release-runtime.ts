// Planted defect: the queue lets the next step run as soon as this step issued its commit, not when the commit landed.
import type { Result, TransitionId } from "../../packages/net/src/index.ts";
import { err, fire, ok } from "../../packages/net/src/index.ts";
import type { InstanceState, Runtime, RuntimeOptions, StepFailure } from "../../packages/runtime/src/index.ts";
import { createSerialQueue } from "../../packages/runtime/src/serial-queue.ts";

type Prepared = Result<{ readonly next: InstanceState; readonly landed: Promise<void> }, StepFailure>;

export function createEarlyReleaseRuntime(options: RuntimeOptions): Runtime {
	const serial = createSerialQueue();

	async function prepare(id: TransitionId): Promise<Prepared> {
		const transition = options.transitions.find((candidate) => candidate.id === id);
		if (transition === undefined) {
			return err({ kind: "unknown-transition", transition: id });
		}
		const state = await options.store.load();
		const fired = fire(transition, state.marking);
		if (!fired.ok) {
			return fired;
		}
		const next = {
			marking: fired.value,
			occurrences: [...state.occurrences, { transition: id, at: options.clock.now() }],
		};
		return ok({ next, landed: options.store.commit(next) });
	}

	return {
		step: async (id: TransitionId): Promise<Result<InstanceState, StepFailure>> => {
			const prepared = await serial(() => prepare(id));
			if (!prepared.ok) {
				return prepared;
			}
			await prepared.value.landed;
			return ok(prepared.value.next);
		},
	};
}
