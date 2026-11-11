import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Recording } from "./model.ts";

const node = Type.Object({
	id: Type.String(),
	kind: Type.Union([Type.Literal("place"), Type.Literal("transition")]),
	name: Type.String(),
	detail: Type.String(),
});
const arc = Type.Object({ id: Type.String(), source: Type.String(), target: Type.String(), label: Type.String() });
const marking = Type.Record(Type.String(), Type.Array(Type.Unknown()));
const element = Type.Object({ transition: Type.String(), binding: Type.Record(Type.String(), Type.Unknown()) });
const frame = Type.Object({
	kind: Type.Union([Type.Literal("initial"), Type.Literal("ingress"), Type.Literal("occurrence")]),
	label: Type.String(),
	at: Type.Union([Type.Number(), Type.Null()]),
	binding: Type.Record(Type.String(), Type.Unknown()),
	marking,
	enabled: Type.Array(element),
});

const recording = Type.Object({
	format: Type.Literal("petrus-recording-1"),
	title: Type.String(),
	source: Type.String(),
	nodes: Type.Array(node),
	arcs: Type.Array(arc),
	frames: Type.Array(frame, { minItems: 1 }),
	committedMarking: marking,
});

/** Validates untrusted display data before a host passes it to a viewer. */
export function readRecording(value: unknown): Recording {
	if (!Value.Check(recording, value)) throw new TypeError("The recording has an invalid format");
	return value;
}
