import { track } from "@earendil-works/chord/delta";
import type { MarkingJournalOp, Net } from "@petrus/petri-net";
import { markingOfIndexed, placeId, transitionId } from "@petrus/petri-net";
import { describe, expect, test } from "vitest";
import { buildIngressIndex, ingressBucketOf, ingressIndexOf, insertIngress } from "../src/ingress-index.ts";
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
const after: NetInstanceState = { marking: { [placeId("p")]: tokens }, log: [ingress, occurrence] };
const initialJournal: readonly MarkingJournalOp[] = [{ kind: "append", place: placeId("p"), tokens }];
const net: Net = { places: [{ id: placeId("p"), colourSet: { name: "JSON", contains: () => true } }], transitions: [] };

describe("the net instance record", () => {
	test("is stored under the stable kind petrus.net-instance, and each commit after the first stores only its change", () => {
		// Hosts and tests find the records by this kind. A whole copy at each commit would rewrite the whole log.
		const { definition } = netInstanceRecord;
		expect(definition.kind).toBe("petrus.net-instance");
		expect(
			definition.checkpointWhen(definition.initial(), [], {
				deltasSinceBase: 1_000,
			}),
		).toBe(false);
	});

	test("round-trips a state through a stored instance and names the net that owns it", () => {
		const draft = netInstanceRecord.definition.initial();
		writeNetInstance(draft, "contested", initialJournal, after.log);
		expect(draft.net).toBe("contested");
		expect(readNetInstance(draft)).toStrictEqual(after);
	});

	test("appends the new log entries and indexes each new ingress by its log index", () => {
		const draft = netInstanceRecord.definition.initial();
		const second = { ...ingress, requestId: "delivery-2", at: 6 };
		writeNetInstance(draft, "contested", [], [ingress]);
		writeNetInstance(draft, "contested", [], [occurrence, second]);
		expect(readNetInstance(draft).log).toStrictEqual([ingress, occurrence, second]);
		expect(draft.ingresses).toStrictEqual(
			buildIngressIndex([
				["delivery-1", 0],
				["delivery-2", 2],
			]),
		);
	});

	test("a view of a stored instance finds an ingress by its request id and an entry by its index", () => {
		const draft = netInstanceRecord.definition.initial();
		writeNetInstance(draft, "contested", initialJournal, after.log);
		const view = readNetInstanceView(draft);
		expect({ marking: markingOfIndexed(view.indexed(net)), logLength: view.logLength }).toStrictEqual({
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
		writeNetInstance(draft, "contested", [], [occurrence]);
		insertIngress(draft.ingresses, "delivery-1", 0);
		expect(readNetInstanceView(draft).ingressOf("delivery-1")).toBeUndefined();
	});

	test("a view finds no ingress where the index points at the ingress of another request id, which is a bug in the store", () => {
		const draft = netInstanceRecord.definition.initial();
		writeNetInstance(draft, "contested", [], [ingress]);
		insertIngress(draft.ingresses, "delivery-2", 0);
		expect(readNetInstanceView(draft).ingressOf("delivery-2")).toBeUndefined();
	});

	test("indexes a request id that names a property of every object as any other", () => {
		const draft = netInstanceRecord.definition.initial();
		const reserved = ["__proto__", "constructor", "toString"].map((requestId) => ({ ...ingress, requestId }));
		writeNetInstance(draft, "contested", [], reserved);
		expect(reserved.map(({ requestId }) => readNetInstanceView(draft).ingressOf(requestId))).toStrictEqual(reserved);
		expect(readNetInstanceView(draft).ingressOf("hasOwnProperty")).toBeUndefined();
	});

	test("a view shares no list or record with the stored instance", () => {
		const draft = netInstanceRecord.definition.initial();
		writeNetInstance(draft, "contested", initialJournal, after.log);
		const view = readNetInstanceView(draft);
		const [stored] = draft.log;
		const found = view.ingressOf("delivery-1");
		expect(found?.tokens[placeId("p")]).not.toBe(stored?.kind === "ingress" ? stored.tokens.p : undefined);
		const marking = markingOfIndexed(view.indexed(net));
		expect(marking[placeId("p")]).not.toBe(draft.marking.p);
	});

	test("validates and copies the marking only when a view builds its index, without reading log entries", () => {
		const draft = netInstanceRecord.definition.initial();
		draft.marking = { unknown: [1] };
		draft.log = [ingress].map(() => ({ kind: "ingress", requestId: "r", tokens: {}, at: 0 }));
		Object.defineProperty(draft.log, "0", {
			get: () => {
				throw new Error("unexpected log read");
			},
		});
		const view = readNetInstanceView(draft);
		expect(view.logLength).toBe(1);
		expect(() => view.indexed(net)).toThrow(
			new BrokenNetInstance("invalid stored marking: marking: place unknown is not in the net"),
		);
		draft.marking = { p: [1] };
		expect(markingOfIndexed(view.indexed(net))).toStrictEqual({ p: [1] });
	});

	test("has one version and no migration", () => {
		// No release has stored a record yet, so there is no older version to migrate.
		const { definition } = netInstanceRecord;
		expect(definition.version).toBe(1);
		expect(definition).not.toHaveProperty("migrate");
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
			stamp: "",
			marking: { p: [list] },
			log: [{ kind: "occurrence", transition: "t", binding: { x: bound }, at: 5 }],
			ingresses: buildIngressIndex([]),
		};
		const state = readNetInstance(stored);
		expect(state).toStrictEqual({ marking: { p: [list] }, log: [{ ...occurrence, binding: { x: bound } }] });
		const [entry] = state.log;
		expect(state.marking[placeId("p")]?.[0]).not.toBe(list);
		expect(entry?.kind === "occurrence" ? entry.binding.x : undefined).not.toBe(bound);
	});

	test("initializes with an empty stamp and 1024 independent empty buckets", () => {
		const first = netInstanceRecord.definition.initial();
		const second = netInstanceRecord.definition.initial();
		expect(first.stamp).toBe("");
		expect(first.ingresses).toStrictEqual(Array.from({ length: 1024 }, () => []));
		expect(new Set(first.ingresses).size).toBe(1024);
		writeNetInstance(first, "contested", [], [ingress]);
		expect(second.ingresses.flat()).toStrictEqual([]);
		expect(first.stamp).toBe("");
	});

	test("replays a journal on reserved place names and restores insertion order after a drop", () => {
		const tracker = track(netInstanceRecord.definition.initial());
		const change = tracker.beginChange();
		const first = placeId("__proto__");
		const second = placeId("constructor");
		writeNetInstance(
			change.state,
			"reserved",
			[
				{ kind: "append", place: first, tokens: ["a", "b"] },
				{ kind: "append", place: second, tokens: ["c"] },
				{ kind: "remove", place: first, index: 1 },
				{ kind: "remove", place: first, index: 0 },
				{ kind: "drop", place: first },
				{ kind: "append", place: first, tokens: ["d"] },
				{ kind: "append", place: second, tokens: ["e"] },
			],
			[],
		);
		const prepared = change.prepare();
		expect(JSON.stringify(prepared.value.marking)).toBe('{"constructor":["c","e"],"__proto__":["d"]}');
		expect(tracker.value.marking).toStrictEqual({});
		prepared.abort();
	});

	test("one commit changes exactly one ingress bucket path", () => {
		const initial = netInstanceRecord.definition.initial();
		writeNetInstance(initial, "contested", [], [{ ...ingress, requestId: "old" }]);
		const tracker = track(initial);
		const change = tracker.beginChange();
		writeNetInstance(change.state, "contested", [], [ingress, occurrence]);
		const prepared = change.prepare();
		const paths = prepared.ops.flatMap((op) => (op[0] !== "r" && op[1][0] === "ingresses" ? [op[1]] : []));
		expect(paths).toStrictEqual([["ingresses", ingressBucketOf(ingress.requestId)]]);
		expect(ingressIndexOf(prepared.value.ingresses, ingress.requestId)).toBe(1);
		expect(ingressIndexOf(tracker.value.ingresses, ingress.requestId)).toBeUndefined();
		prepared.abort();
	});
});
