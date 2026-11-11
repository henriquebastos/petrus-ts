import type { PlaceId } from "./ids.ts";
import type { Token } from "./token.ts";

/** Operations in application order. Remove indices refer to the array after preceding operations. */
export type MarkingJournalOp =
	| { readonly kind: "remove"; readonly place: PlaceId; readonly index: number }
	| { readonly kind: "append"; readonly place: PlaceId; readonly tokens: readonly Token[] }
	| { readonly kind: "drop"; readonly place: PlaceId };
