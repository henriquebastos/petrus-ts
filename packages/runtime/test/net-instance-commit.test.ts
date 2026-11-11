import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { definitionOrder, markingOfIndexed } from "@petrus/petri-net";
import { describe, expect, test } from "vitest";
import { createNetInstanceCache } from "../src/net-instance-cache.ts";
import type { Batch } from "../src/index.ts";
import { busyPlaceId } from "../src/index.ts";
import { admit } from "../src/admit.ts";
import type { Change, NetInstanceParts } from "../src/net-instance-commit.ts";
import { commitToRecord, plan } from "../src/net-instance-commit.ts";
import type { NetInstanceRecord } from "../src/net-instance-record.ts";
import { netInstanceRecord } from "../src/net-instance-record.ts";
import { viewOf } from "../src/net-instance-view.ts";
import { admitResult } from "../src/operations.ts";
import { firstBatch, plainJobsNet, queue, work } from "./handler-properties.ts";

const parts: NetInstanceParts = {
	name: "jobs",
	cache: createNetInstanceCache(randomUUID()),
	net: plainJobsNet,
	policy: definitionOrder,
	handlerIds: new Set([work.id]),
	start: () => Promise.reject(new Error("plan starts nothing")),
};

const empty = viewOf({ marking: {}, log: [] });
const conversation = ROOT_CONVERSATION_ID;

describe("plan", () => {
	test("steps a new change until the net is quiet and starts only the operations that its own steps started", () => {
		const first = plan(parts, empty, admit(plainJobsNet, empty, firstBatch(["j1"]), 1), 1);
		expect(first.kind === "applied" && first.started).toStrictEqual([
			{ id: "work/1", transition: work.id, binding: { j: "j1", s: "slot" } },
		]);
		const before =
			first.kind === "applied" ? viewOf({ marking: markingOfIndexed(first.indexed), log: first.appended }) : empty;
		const late = { requestId: "late", tokens: { [queue.id]: ["j4"] } };
		const second = plan(parts, before, admit(plainJobsNet, before, late, 2), 2);
		expect(second.kind === "applied" && { ...second, marking: markingOfIndexed(second.indexed) }).toMatchObject({
			kind: "applied",
			marking: {
				[busyPlaceId(work.id)]: [
					{ j: "j1", s: "slot" },
					{ j: "j4", s: "slot" },
				],
			},
			appended: [
				{ kind: "ingress", ...late, at: 2 },
				{ kind: "occurrence", transition: work.id, binding: { j: "j4", s: "slot" }, at: 2 },
			],
			started: [{ id: "work/3", transition: work.id, binding: { j: "j4", s: "slot" } }],
		});
	});

	test("plans nothing for a repeated change and keeps its recorded ingress", () => {
		const first = plan(parts, empty, admit(plainJobsNet, empty, firstBatch(["j1"]), 1), 1);
		const view =
			first.kind === "applied" ? viewOf({ marking: markingOfIndexed(first.indexed), log: first.appended }) : empty;
		const repeated = admit(plainJobsNet, view, firstBatch(["j1"]), 2);
		expect(plan(parts, view, repeated, 2)).toStrictEqual(repeated);
		expect(repeated.ingress.at).toBe(1);
	});
});

function jobBatch(job: number): Batch {
	return { requestId: `job-${String(job)}`, tokens: { [queue.id]: [`j${String(job)}`] } };
}

/**
 * A stored instance after the first batch, which starts the operation work/1, and `jobs` more batches. The log of
 * the copy that it returns counts each read of an entry, by its index.
 */
function countedRecord(jobs: number): { readonly record: NetInstanceRecord; readonly reads: string[] } {
	const record = netInstanceRecord.definition.initial();
	commitToRecord(parts, record, (view) => admit(plainJobsNet, view, firstBatch(["j0"]), 0), 0, conversation);
	for (let job = 1; job <= jobs; job += 1) {
		commitToRecord(parts, record, (view) => admit(plainJobsNet, view, jobBatch(job), job), job, conversation);
	}
	const reads: string[] = [];
	const log = new Proxy(record.log, {
		get: (target, key, receiver) => {
			// The length and the array methods are not entries; Array.prototype has each of them.
			if (typeof key === "string" && !(key in Array.prototype)) {
				reads.push(key);
			}
			const value: unknown = Reflect.get(target, key, receiver);
			return value;
		},
	});
	return { record: { ...record, log }, reads };
}

describe("the cost of a commit", () => {
	test("a new batch reads no log entry, at any log length", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 30 }), fc.constantFrom("job-new", "constructor"), (jobs, requestId) => {
				const { record, reads } = countedRecord(jobs);
				const batch = { requestId, tokens: { [queue.id]: ["j99"] } };
				const planned = commitToRecord(
					parts,
					record,
					(view) => admit(plainJobsNet, view, batch, 99),
					99,
					conversation,
				);
				expect({ kind: planned.kind, reads }).toStrictEqual({ kind: "applied", reads: [] });
			}),
		);
	});

	test("a batch sent again reads only its ingress, at any log length", () => {
		fc.assert(
			fc.property(
				fc
					.integer({ min: 1, max: 30 })
					.chain((jobs) => fc.tuple(fc.constant(jobs), fc.integer({ min: 1, max: jobs }))),
				([jobs, job]) => {
					const { record, reads } = countedRecord(jobs);
					const index = record.log.findIndex(
						(entry) => entry.kind === "ingress" && entry.requestId === jobBatch(job).requestId,
					);
					reads.length = 0;
					const planned = commitToRecord(
						parts,
						record,
						(view) => admit(plainJobsNet, view, jobBatch(job), 99),
						99,
						conversation,
					);
					expect({ kind: planned.kind, at: planned.ingress.at, reads }).toStrictEqual({
						kind: "repeated",
						at: job,
						reads: [String(index)],
					});
				},
			),
		);
	});

	test("a result reads only its start and a recorded result, at any log length", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 30 }), (jobs) => {
				const { record, reads } = countedRecord(jobs);
				const result =
					(variant: string, value: string): Change =>
					(view) =>
						admitResult(plainJobsNet, parts.handlerIds, view, "work/1", { variant, value }, 99);
				const first = commitToRecord(parts, record, result("done", "receipt 1"), 99, conversation);
				expect({ kind: first.kind, reads }).toStrictEqual({ kind: "applied", reads: ["1"] });
				const resultIndex = record.log.length - (first.kind === "applied" ? first.appended.length : 0);
				reads.length = 0;
				const second = commitToRecord(parts, record, result("refused", "refused"), 100, conversation);
				expect({ kind: second.kind, reads }).toStrictEqual({ kind: "repeated", reads: ["1", String(resultIndex)] });
			}),
		);
	});
});
