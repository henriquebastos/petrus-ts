/** A place name. The brand stops a transition id or a plain string from being used as a place. */
export type PlaceId = string & { readonly __brand: "PlaceId" };

/** A transition name. The brand stops a place id or a plain string from being used as a transition. */
export type TransitionId = string & { readonly __brand: "TransitionId" };

export function placeId(name: string): PlaceId {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- brand constructor: the only place that creates a PlaceId
	return name as PlaceId;
}

export function transitionId(name: string): TransitionId {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- brand constructor: the only place that creates a TransitionId
	return name as TransitionId;
}
