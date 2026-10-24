import type { Binding, Marking, TransitionId } from "@petrus/petri-net";

/** One firing that the runtime committed: the binding element that occurred, and when. */
export type Occurrence = { readonly transition: TransitionId; readonly binding: Binding; readonly at: number };

/** The stored state of one net instance. The marking and the occurrence log change in the same commit. */
export type NetInstanceState = { readonly marking: Marking; readonly occurrences: readonly Occurrence[] };

/**
 * Storage for one net instance. `commit` is atomic: after a crash the store holds the old state
 * or the new state, never a part of each.
 */
export type NetInstanceStore = {
	readonly load: () => Promise<NetInstanceState>;
	readonly commit: (state: NetInstanceState) => Promise<void>;
};
