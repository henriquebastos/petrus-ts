import { definitionOrder } from "@petrus/petri-net";
import { describe, expect, test } from "vitest";
import type { NetInstanceState } from "../src/index.ts";
import { busyPlaceId } from "../src/index.ts";
import { admit } from "../src/admit.ts";
import type { NetInstanceParts } from "../src/net-instance-commit.ts";
import { plan } from "../src/net-instance-commit.ts";
import { firstBatch, plainJobsNet, queue, work } from "./handler-properties.ts";

const parts: NetInstanceParts = {
	name: "jobs",
	net: plainJobsNet,
	policy: definitionOrder,
	handlerIds: new Set([work.id]),
	start: () => Promise.reject(new Error("plan starts nothing")),
};

const empty: NetInstanceState = { marking: {}, log: [] };

describe("plan", () => {
	test("steps a new change until the net is quiet and starts only the operations that its own steps started", () => {
		const first = plan(parts, empty, admit(plainJobsNet, empty, firstBatch(["j1"]), 1), 1);
		expect(first.kind === "applied" && first.started).toStrictEqual([
			{ id: "work/1", transition: work.id, binding: { j: "j1", s: "slot" } },
		]);
		const before = first.kind === "applied" ? first.state : empty;
		const late = { requestId: "late", tokens: { [queue.id]: ["j4"] } };
		const second = plan(parts, before, admit(plainJobsNet, before, late, 2), 2);
		expect(second).toMatchObject({
			kind: "applied",
			state: {
				marking: {
					[busyPlaceId(work.id)]: [
						{ j: "j1", s: "slot" },
						{ j: "j4", s: "slot" },
					],
				},
			},
			started: [{ id: "work/3", transition: work.id, binding: { j: "j4", s: "slot" } }],
		});
	});

	test("plans nothing for a repeated change and keeps its recorded ingress", () => {
		const first = plan(parts, empty, admit(plainJobsNet, empty, firstBatch(["j1"]), 1), 1);
		const state = first.kind === "applied" ? first.state : empty;
		const repeated = admit(plainJobsNet, state, firstBatch(["j1"]), 2);
		expect(plan(parts, state, repeated, 2)).toStrictEqual(repeated);
		expect(repeated.ingress.at).toBe(1);
	});
});
