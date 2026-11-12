import type { BindingElement, Marking } from "@petrus/petri-net";

/**
 * One binding element that the runtime committed, and when. The occurrences of one step share `at` and are in
 * firing order, so replaying them one by one with `fire` gives the step's tokens.
 */
export type Occurrence = BindingElement & { readonly kind: "occurrence"; readonly at: number };

/**
 * Tokens that a host adds from outside, under the host's own id for them. A retry of the same input, or a second
 * delivery of it, must use the same id.
 */
export type Batch = { readonly requestId: string; readonly tokens: Marking };

/** A batch that the runtime applied, and when. */
export type Ingress = Batch & { readonly kind: "ingress"; readonly at: number };

/** The log records, in commit order, what changed the marking. Replaying it from the first marking gives the marking. */
export type LogEntry = Occurrence | Ingress;

/** The state of one net instance. The marking and the log change in the same commit. */
export type NetInstanceState = { readonly marking: Marking; readonly log: readonly LogEntry[] };

/** Durable authored-start usage. A refused whole step pauses allocation until the host raises the ceiling. */
export type StartBudget = { readonly ceiling: number; readonly used: number; readonly paused: boolean };

/**
 * A bug that the runtime finds in a net instance or its net, such as a stored marking that does not fit the net or a
 * net that does not become quiet. A commit with the same input throws it again, so a handler task that meets it ends
 * faulted.
 */
export class BrokenNetInstance extends Error {
	override readonly name = "BrokenNetInstance";
}
