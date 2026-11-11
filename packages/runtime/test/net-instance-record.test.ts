import { placeId, transitionId } from "@petrus/petri-net";
import { describe, expect, test } from "vitest";
import type { NetInstanceState } from "../src/index.ts";
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

	test("has one version and no migration", () => {
		// No release has stored a record yet, so there is no older version to migrate.
		const { definition } = netInstanceRecord;
		expect(definition.version).toBe(1);
		expect(definition).not.toHaveProperty("migrate");
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
