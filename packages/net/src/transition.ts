import type { PlaceId, TransitionId } from "./ids.ts";

/** An arc moves `weight` tokens. `weight` is a positive integer. */
export type Arc = { readonly place: PlaceId; readonly weight: number };

/** A transition consumes the input arcs' tokens and produces the output arcs' tokens in one firing. */
export type Transition = {
	readonly id: TransitionId;
	readonly inputs: readonly Arc[];
	readonly outputs: readonly Arc[];
};
