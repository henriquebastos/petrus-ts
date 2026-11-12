import type { ColourSet, Marking, Net, Transition } from "@petrus/petri-net";
import { placeId, transitionId } from "@petrus/petri-net";
import type { HandlerTransition } from "@petrus/runtime";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

const Revision = Type.Object({ seq: Type.Integer({ minimum: 0 }), sha: Type.String() });
export const Findings = Type.Array(Type.Object({ id: Type.String(), note: Type.String() }));
const Memory = Type.Object({ reviewedSeq: Type.Integer({ minimum: 0 }), findings: Findings });
export const Work = Type.Object({ c: Revision, m: Memory });
export type ReviewWork = Readonly<Static<typeof Work>>;
export type ReviewFindings = Static<typeof Findings>;

function colour(name: string, schema: TSchema): ColourSet {
	return { name, contains: (token) => Value.Check(schema, token) };
}

const revision = colour("Revision {seq, sha}", Revision);
const memory = colour("Memory {reviewedSeq, findings}", Memory);
const work = colour("Work {c, m}", Work);
export const commits = { id: placeId("Commits"), colourSet: revision };
export const current = { id: placeId("Current"), colourSet: revision };
export const memories = { id: placeId("Memory"), colourSet: memory };
const workItems = { id: placeId("Work"), colourSet: work };
export const reports = {
	id: placeId("Reports"),
	colourSet: colour("Report {seq, sha, findings}", Type.Object({ ...Revision.properties, findings: Findings })),
};

const adopt: Transition<"c" | "n"> = {
	id: transitionId("Adopt"),
	variables: { c: revision, n: revision },
	guard: ({ c, n }) => Value.Parse(Revision, n).seq === Value.Parse(Revision, c).seq + 1,
	inputs: [
		{ place: commits, variables: ["n"] },
		{ place: current, variables: ["c"] },
	],
	outputs: [{ place: current, expression: ({ n }) => [n] }],
};

const select: Transition<"c" | "m"> = {
	id: transitionId("Select"),
	variables: { c: revision, m: memory },
	guard: ({ c, m }) => Value.Parse(Revision, c).seq > Value.Parse(Memory, m).reviewedSeq,
	inputs: [
		{ place: current, variables: ["c"] },
		{ place: memories, variables: ["m"] },
	],
	outputs: [
		{ place: current, expression: ({ c }) => [c] },
		{ place: workItems, expression: ({ c, m }) => [{ c, m }] },
	],
};

/** Review holds memory inside Work, never the token that lets Adopt advance Current. */
export const review: HandlerTransition<"w"> = {
	id: transitionId("Review"),
	variables: { w: work },
	guard: () => true,
	inputs: [{ place: workItems, variables: ["w"] }],
	variants: {
		reviewed: {
			value: colour("Findings", Findings),
			outputs: [
				{
					place: memories,
					expression: ({ w }, findings) => [{ reviewedSeq: Value.Parse(Work, w).c.seq, findings }],
				},
				{ place: reports, expression: ({ w }, findings) => [{ ...Value.Parse(Work, w).c, findings }] },
			],
		},
	},
};

/** Definition order gives Adopt priority over Select when they compete for Current. */
export const net: Net = {
	places: [commits, current, memories, workItems, reports],
	transitions: [adopt, select],
};

export const initial: Marking = {
	[current.id]: [{ seq: 0, sha: "base" }],
	[memories.id]: [{ reviewedSeq: 0, findings: [] }],
};
