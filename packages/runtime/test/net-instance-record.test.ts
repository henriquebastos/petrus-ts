import { placeId, transitionId } from "@petrus/petri-net";
import { describe, expect, test } from "vitest";
import type { NetInstanceState } from "../src/index.ts";
import { BrokenNetInstance } from "../src/net-instance.ts";
import type { NetInstanceRecord } from "../src/net-instance-record.ts";
import {
	json,
	netInstanceRecord,
	readNetInstance,
	readNetInstanceView,
	writeNetInstance,
} from "../src/net-instance-record.ts";

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
			definition.checkpointWhen({ net: "contested", marking: {}, log: [], ingresses: {} }, [], {
				deltasSinceBase: 1_000,
			}),
		).toBe(false);
	});

	test("round-trips a state through a stored instance and names the net that owns it", () => {
		const draft = netInstanceRecord.definition.initial();
		writeNetInstance(draft, "contested", after.marking, after.log);
		expect(draft.net).toBe("contested");
		expect(readNetInstance(draft)).toStrictEqual(after);
	});

	test("appends the new log entries and indexes each new ingress by its log index", () => {
		const draft = netInstanceRecord.definition.initial();
		const second = { ...ingress, requestId: "delivery-2", at: 6 };
		writeNetInstance(draft, "contested", {}, [ingress]);
		writeNetInstance(draft, "contested", {}, [occurrence, second]);
		expect(readNetInstance(draft).log).toStrictEqual([ingress, occurrence, second]);
		expect(draft.ingresses).toStrictEqual({ "request:delivery-1": 0, "request:delivery-2": 2 });
	});

	test("a view of a stored instance finds an ingress by its request id and an entry by its index", () => {
		const draft = netInstanceRecord.definition.initial();
		writeNetInstance(draft, "contested", after.marking, after.log);
		const view = readNetInstanceView(draft);
		expect({ marking: view.marking, logLength: view.logLength }).toStrictEqual({
			marking: after.marking,
			logLength: 2,
		});
		expect([view.ingressOf("delivery-1"), view.entryAt(0), view.entryAt(1)]).toStrictEqual([
			ingress,
			ingress,
			occurrence,
		]);
		expect([view.ingressOf("delivery-2"), view.ingressOf("constructor"), view.entryAt(2)]).toStrictEqual([
			undefined,
			undefined,
			undefined,
		]);
	});

	test("a view finds no ingress where the index points at an occurrence, which is a bug in the store", () => {
		const draft = netInstanceRecord.definition.initial();
		writeNetInstance(draft, "contested", {}, [occurrence]);
		draft.ingresses["request:delivery-1"] = 0;
		expect(readNetInstanceView(draft).ingressOf("delivery-1")).toBeUndefined();
	});

	test("a view finds no ingress where the index points at the ingress of another request id, which is a bug in the store", () => {
		const draft = netInstanceRecord.definition.initial();
		writeNetInstance(draft, "contested", {}, [ingress]);
		draft.ingresses["request:delivery-2"] = 0;
		expect(readNetInstanceView(draft).ingressOf("delivery-2")).toBeUndefined();
	});

	test("indexes a request id that names a property of every object as any other", () => {
		const draft = netInstanceRecord.definition.initial();
		const reserved = ["__proto__", "constructor", "toString"].map((requestId) => ({ ...ingress, requestId }));
		writeNetInstance(draft, "contested", {}, reserved);
		expect(reserved.map(({ requestId }) => readNetInstanceView(draft).ingressOf(requestId))).toStrictEqual(reserved);
		expect(readNetInstanceView(draft).ingressOf("hasOwnProperty")).toBeUndefined();
	});

	test("a view shares no list or record with the stored instance", () => {
		const draft = netInstanceRecord.definition.initial();
		writeNetInstance(draft, "contested", after.marking, after.log);
		const view = readNetInstanceView(draft);
		const [stored] = draft.log;
		const found = view.ingressOf("delivery-1");
		expect(found?.tokens[placeId("p")]).not.toBe(stored?.kind === "ingress" ? stored.tokens.p : undefined);
		expect(view.marking[placeId("p")]).not.toBe(draft.marking.p);
	});

	test("migrates a version 1 record by indexing its ingresses", () => {
		const version1 = {
			net: "contested",
			marking: { p: ["j1"] },
			log: [
				{ kind: "occurrence", transition: "t", binding: { x: "j1" }, at: 3 },
				{ kind: "ingress", requestId: "delivery-1", tokens: { p: ["j1"] }, at: 4 },
				{ kind: "ingress", requestId: "__proto__", tokens: {}, at: 5 },
			],
		};
		const migrated = netInstanceRecord.definition.migrate?.(version1, 1);
		expect(migrated).toMatchObject(version1);
		expect(Object.entries(migrated?.ingresses ?? {})).toStrictEqual([
			["request:delivery-1", 1],
			["request:__proto__", 2],
		]);
	});

	test("refuses to migrate a value that is not a version 1 record, which is a bug in the store", () => {
		const entry = { kind: "ingress", requestId: "r", tokens: { p: [] }, at: 4 };
		const occurrenceEntry = { kind: "occurrence", transition: "t", binding: {}, at: 4 };
		const record = { net: "contested", marking: { p: [] }, log: [entry, occurrenceEntry] };
		expect(netInstanceRecord.definition.migrate?.(record, 1)).toMatchObject({ ingresses: { "request:r": 0 } });
		const wrong = [
			{ ...record, net: 1 },
			{ ...record, marking: [] },
			{ ...record, marking: null },
			{ ...record, marking: { p: "j1" } },
			{ ...record, log: {} },
			{ ...record, log: [entry, "entry"] },
			{ ...record, log: [{ ...entry, at: "4" }] },
			{ ...record, log: [{ ...entry, kind: "other" }] },
			{ ...record, log: [{ ...entry, requestId: 1 }] },
			{ ...record, log: [{ ...entry, tokens: [] }] },
			{ ...record, log: [{ ...occurrenceEntry, kind: "ingress" }] },
			{ ...record, log: [{ ...occurrenceEntry, transition: 1 }] },
			{ ...record, log: [{ ...occurrenceEntry, binding: "x" }] },
		];
		for (const value of wrong) {
			expect(() => netInstanceRecord.definition.migrate?.(value, 1)).toThrow(
				new BrokenNetInstance("a version 1 net instance record needs a net name, a marking and a log of entries"),
			);
		}
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
			ingresses: {},
		};
		const state = readNetInstance(stored);
		expect(state).toStrictEqual({ marking: { p: [list] }, log: [{ ...occurrence, binding: { x: bound } }] });
		const [entry] = state.log;
		expect(state.marking[placeId("p")]?.[0]).not.toBe(list);
		expect(entry?.kind === "occurrence" ? entry.binding.x : undefined).not.toBe(bound);
	});
});
