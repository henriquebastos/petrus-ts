/** A place or transition identified independently of its display name. */
export type ViewNode = {
	readonly id: string;
	readonly kind: "place" | "transition";
	readonly name: string;
	readonly detail: string;
};

/** One directed arc. Parallel arcs have different IDs. */
export type ViewArc = {
	readonly id: string;
	readonly source: string;
	readonly target: string;
	readonly label: string;
};

/** Topology without a renderer, layout, or executable expressions. */
export type NetGraph = { readonly nodes: readonly ViewNode[]; readonly arcs: readonly ViewArc[] };

/** A canvas coordinate. */
export type Point = { readonly x: number; readonly y: number };

/** Layout data is independent of topology and execution. Arc routes contain directed points. */
export type NetLayout = {
	readonly positions: Readonly<Record<string, Point>>;
	readonly routes: Readonly<Record<string, readonly Point[]>>;
	readonly labels: Readonly<Record<string, Point>>;
};

/** Token values are opaque to a display. Multiplicity and order remain intact. */
export type ViewMarking = Readonly<Record<string, readonly unknown[]>>;

/** One display position. Enablement is supplied by Petrus, not inferred by a renderer. */
export type ViewFrame = {
	readonly kind: "initial" | "ingress" | "occurrence";
	readonly label: string;
	readonly at: number | null;
	readonly binding: Readonly<Record<string, unknown>>;
	readonly marking: ViewMarking;
	readonly enabled: readonly {
		readonly transition: string;
		readonly binding: Readonly<Record<string, unknown>>;
	}[];
};

/** A portable display document. A static net has one initial frame. */
export type Recording = NetGraph & {
	readonly format: "petrus-recording-1";
	readonly title: string;
	readonly source: string;
	readonly frames: readonly ViewFrame[];
	readonly committedMarking: ViewMarking;
};

/** Empty places have no entry. Prototype names are valid place names. */
export function viewTokens(marking: ViewMarking, place: string): readonly unknown[] {
	return Object.hasOwn(marking, place) ? (marking[place] ?? []) : [];
}
