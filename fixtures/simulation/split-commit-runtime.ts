// Planted defect: the marking and the occurrence log land in two commits, so a crash between them splits them.
import type { Binding, Result, TransitionId } from "../../packages/petri-net/src/index.ts";
import { err, fire, ok } from "../../packages/petri-net/src/index.ts";
import type { NetInstanceState, Runtime, RuntimeOptions, StepFailure } from "../../packages/runtime/src/index.ts";

export function createSplitCommitRuntime(options: RuntimeOptions): Runtime {
	let tail: Promise<unknown> = Promise.resolve();
	const stepNow = async (id: TransitionId, binding: Binding): Promise<Result<NetInstanceState, StepFailure>> => {
		const transition = options.net.transitions.find((candidate) => candidate.id === id);
		if (transition === undefined) {
			return err({ kind: "unknown-transition", transition: id });
		}
		const state = await options.store.load();
		const fired = fire(transition, binding, state.marking);
		if (!fired.ok) {
			return fired;
		}
		await options.store.commit({ marking: fired.value, occurrences: state.occurrences });
		const next = {
			marking: fired.value,
			occurrences: [...state.occurrences, { transition: id, binding, at: options.clock.now() }],
		};
		await options.store.commit(next);
		return ok(next);
	};
	return {
		step: (id, binding) => {
			const run = tail.then(() => stepNow(id, binding));
			tail = run.catch(() => undefined);
			return run;
		},
	};
}
