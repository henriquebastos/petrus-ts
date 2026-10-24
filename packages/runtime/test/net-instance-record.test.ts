import { placeId, transitionId } from "@petrus/petri-net";
import { describe, expect, test } from "vitest";
import type { NetInstanceState } from "../src/index.ts";
import type { NetInstanceRecord } from "../src/net-instance-record.ts";
import { json, netInstanceRecord, readNetInstance, writeNetInstance } from "../src/net-instance-record.ts";

const tokens = [null, true, 3, "j1", ["a", ["b"]], { k: [1, { deep: "x" }] }];
const ingress = { kind: "ingress", requestId: "delivery-1", tokens: { [placeId("p")]: tokens }, at: 4 } as const;
const occurrence = {
	kind: "occurrence",
	transition: transitionId("t"),
	binding: { x: { k: [1] }, y: "j1" },
	at: 5,
} as const;
const after: NetInstanceState = { marking: { [placeId("p")]: tokens, [placeId("q")]: [] }, log: [ingress, occurrence] };

describe("the net instance record", () => {
	test("is stored under the stable kind petrus.net-instance, and each commit after the first stores only its change", () => {
		// Hosts and tests find the records by this kind. A whole copy at each commit would rewrite the whole log.
		const { definition } = netInstanceRecord;
		expect(definition.kind).toBe("petrus.net-instance");
		expect(
			definition.checkpointWhen({ net: "contested", marking: {}, log: [] }, [], { deltasSinceBase: 1_000 }),
		).toBe(false);
	});

	test("round-trips a state through a stored instance and names the net that owns it", () => {
		const draft: NetInstanceRecord = { net: "", marking: {}, log: [] };
		writeNetInstance(draft, "contested", { marking: {}, log: [] }, after);
		expect(draft.net).toBe("contested");
		expect(readNetInstance(draft)).toStrictEqual(after);
	});

	test("appends only the log entries that are new since the state the commit read", () => {
		const draft: NetInstanceRecord = { net: "contested", marking: {}, log: [] };
		writeNetInstance(draft, "contested", { marking: {}, log: [] }, { marking: {}, log: [ingress] });
		writeNetInstance(draft, "contested", { marking: {}, log: [ingress] }, after);
		expect(readNetInstance(draft).log).toStrictEqual([ingress, occurrence]);
	});

	test("copies a token: the copy has new lists and records", () => {
		const token = tokens[5] ?? null;
		const copy = json(token);
		expect(copy).toStrictEqual(token);
		expect(copy).not.toBe(token);
		const list = ["a", ["b"]];
		const listCopy = json(list);
		expect(listCopy).toStrictEqual(list);
		expect(Array.isArray(listCopy) && listCopy[1]).not.toBe(list[1]);
	});

	test("reads a state that shares no list or record with the stored instance", () => {
		const list = ["a"];
		const bound = ["b"];
		const stored: NetInstanceRecord = {
			net: "contested",
			marking: { p: [list] },
			log: [{ kind: "occurrence", transition: "t", binding: { x: bound }, at: 5 }],
		};
		const state = readNetInstance(stored);
		expect(state).toStrictEqual({ marking: { p: [list] }, log: [{ ...occurrence, binding: { x: bound } }] });
		const [entry] = state.log;
		expect(state.marking[placeId("p")]?.[0]).not.toBe(list);
		expect(entry?.kind === "occurrence" ? entry.binding.x : undefined).not.toBe(bound);
	});
});
