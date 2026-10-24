import type { BindingElement, Marking } from "@petrus/petri-net";

/**
 * One binding element that the runtime committed, and when. The occurrences of one step share `at` and are in
 * firing order, so replaying them one by one with `fire` gives the step's tokens.
 */
export type Occurrence = BindingElement & { readonly at: number };

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
