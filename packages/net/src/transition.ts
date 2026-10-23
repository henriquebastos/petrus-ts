import type { PlaceId, TransitionId } from "./ids.ts";

/** An arc moves `weight` tokens. `weight` is a positive integer. */
export type Arc = { readonly place: PlaceId; readonly weight: number };

export type Transition = {
	readonly id: TransitionId;
	readonly inputs: readonly Arc[];
	readonly outputs: readonly Arc[];
};
