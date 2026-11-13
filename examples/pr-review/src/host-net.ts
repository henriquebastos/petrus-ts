import type { Binding, Marking, Net, Token, Transition } from "@petrus/petri-net";
import { placeId, transitionId } from "@petrus/petri-net";
import type { HandlerTransition } from "@petrus/runtime";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { colour, current, initial, net, reports } from "./net.ts";

// The host keeps the demo's Adopt, Select and Review. Its tokens add fields to the demo's tokens; TypeBox objects
// accept extra fields, so the demo's colour sets still hold them, and the host parses them with these schemas.
export const Head = Type.Object({ seq: Type.Integer({ minimum: 1 }), sha: Type.String(), base: Type.String() });
const common = { id: Type.String(), note: Type.String(), since: Type.String() };
/** `since` names the commit whose review first reported the finding. */
export const HostFinding = Type.Union([
	Type.Object({
		...common,
		kind: Type.Literal("line"),
		path: Type.String(),
		startLine: Type.Integer({ minimum: 1 }),
		line: Type.Integer({ minimum: 1 }),
		suggestion: Type.String(),
	}),
	Type.Object({ ...common, kind: Type.Literal("design") }),
]);
const HostFindings = Type.Array(HostFinding);
export const HostWork = Type.Object({
	c: Head,
	m: Type.Object({ reviewedSeq: Type.Integer({ minimum: 0 }), findings: HostFindings }),
});
export const HostReport = Type.Object({ ...Head.properties, findings: HostFindings });
const Mode = Type.Object({ publish: Type.Boolean() });
export const Posted = Type.Union([Type.Null(), Type.Object({ id: Type.Integer(), url: Type.String() })]);
export type HostFinding = Static<typeof HostFinding>;
export type HostReport = Static<typeof HostReport>;
export type Posted = Static<typeof Posted>;

const report = reports.colourSet;
const outbox = { id: placeId("Outbox"), colourSet: colour("Report {seq, sha, base, findings}", HostReport) };
export const withheld = { id: placeId("Withheld"), colourSet: report };
export const published = {
	id: placeId("Published"),
	colourSet: colour(
		"Published {seq, sha, review}",
		Type.Object({ seq: Type.Integer(), sha: Type.String(), review: Posted }),
	),
};
export const mode = { id: placeId("Mode"), colourSet: colour("Mode {publish}", Mode) };

const seqOf = (token: unknown): number => Value.Parse(Type.Object({ seq: Type.Integer() }), token).seq;

/**
 * Classify and Withhold are the publication cutoff, as Select is the selection cutoff. Each reserves Current with the
 * report. A report is fresh when no newer head was adopted first. A head adopted after this reservation cannot change
 * the decision; GitHub then shows the published comments as outdated.
 */
function classification(id: string, fresh: boolean, place: typeof outbox): Transition<"r" | "c"> {
	return {
		id: transitionId(id),
		variables: { r: report, c: current.colourSet },
		guard: ({ r, c }) => (seqOf(r) === seqOf(c)) === fresh,
		inputs: [
			{ place: reports, variables: ["r"] },
			{ place: current, variables: ["c"] },
		],
		outputs: [
			{ place: current, expression: ({ c }) => [c] },
			{ place, expression: ({ r }) => [r] },
		],
	};
}

/** Mode stays held while a review posts, so reviews post one at a time in report order. */
export const publish: HandlerTransition<"o" | "m"> = {
	id: transitionId("Publish"),
	variables: { o: outbox.colourSet, m: mode.colourSet },
	guard: () => true,
	inputs: [
		{ place: outbox, variables: ["o"] },
		{ place: mode, variables: ["m"] },
	],
	variants: {
		published: {
			value: colour("Posted review {id, url} or null", Posted),
			outputs: [
				{ place: mode, expression: ({ m }) => [m] },
				{
					place: published,
					expression: ({ o }: Binding<"o" | "m">, review: Token): readonly Token[] => {
						const { seq, sha } = Value.Parse(HostReport, o);
						return [{ seq, sha, review }];
					},
				},
			],
		},
	},
};

/** A stale report goes to Withheld. Its findings already reached Memory, so the next review rechecks them. */
export const hostNet: Net = {
	places: [...net.places, outbox, withheld, published, mode],
	transitions: [
		...net.transitions,
		classification("Classify", true, outbox),
		classification("Withhold", false, withheld),
	],
};

/** Mode is part of the first batch, so a state directory either previews reviews or posts them, never both. */
export function hostInitial(publishing: boolean): Marking {
	return { ...initial, [mode.id]: [{ publish: publishing }] };
}
