import type { Marking, TransitionId } from "@petrus/petri-net";

/** One firing that the runtime committed. */
export type Occurrence = { readonly transition: TransitionId; readonly at: number };

/** The stored state of one net instance. The marking and the occurrence log change in the same commit. */
export type InstanceState = { readonly marking: Marking; readonly occurrences: readonly Occurrence[] };

/**
 * Storage for one instance. `commit` is atomic: after a crash the store holds the old state
 * or the new state, never a part of each.
 */
export type InstanceStore = {
	readonly load: () => Promise<InstanceState>;
	readonly commit: (state: InstanceState) => Promise<void>;
};
