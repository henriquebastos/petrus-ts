import { placeId } from "@petrus/petri-net";
import { describe, expect, test } from "vitest";
import type { NetInstanceState } from "../src/index.ts";
import { admit } from "../src/admit.ts";
import { viewOf } from "../src/net-instance-view.ts";
import { contested, initialState, left, ready } from "./properties.ts";

const batch = { requestId: "delivery-1", tokens: { [ready.id]: ["j1"], [left.id]: ["j2"] } };
const ingress = { kind: "ingress", ...batch, at: 4 } as const;

describe("admit", () => {
	test("applies a new batch: adds its tokens after those already there and returns its ingress", () => {
		expect(admit(contested, viewOf(initialState), batch, 4)).toStrictEqual({
			kind: "applied",
			ingress,
			marking: { [ready.id]: ["j1", "j2", "j1"], [left.id]: ["j2"] },
		});
	});

	test("returns the recorded ingress for a request id the log holds, whatever the order of its places", () => {
		const state: NetInstanceState = { marking: initialState.marking, log: [ingress] };
		const retry = { requestId: "delivery-1", tokens: { [left.id]: ["j2"], [ready.id]: ["j1"] } };
		expect(admit(contested, viewOf(state), retry, 9)).toStrictEqual({ kind: "repeated", ingress });
	});

	test("refuses a request id that the log holds with other tokens, which is a bug in the host", () => {
		const state: NetInstanceState = { marking: initialState.marking, log: [ingress] };
		const other = { requestId: "delivery-1", tokens: { [ready.id]: ["j2"] } };
		expect(() => admit(contested, viewOf(state), other, 9)).toThrow(
			new Error("request delivery-1 already added other tokens"),
		);
	});

	test("counts the order of tokens on a place, so the same id with the tokens reordered is other tokens", () => {
		const twice = { kind: "ingress", requestId: "r", tokens: { [ready.id]: ["j1", "j2"] }, at: 1 } as const;
		const state: NetInstanceState = { marking: initialState.marking, log: [twice] };
		const swapped = { requestId: "r", tokens: { [ready.id]: ["j2", "j1"] } };
		expect(() => admit(contested, viewOf(state), swapped, 9)).toThrow(
			new Error("request r already added other tokens"),
		);
	});

	test("refuses a batch that does not fit the net, even under a recorded request id", () => {
		const state: NetInstanceState = { marking: initialState.marking, log: [ingress] };
		const retry = { requestId: "delivery-1", tokens: { [ready.id]: ["j9"] } };
		expect(() => admit(contested, viewOf(state), retry, 9)).toThrow(
			'invalid batch delivery-1: marking: "j9" on ready',
		);
	});

	test("refuses a batch that does not fit the net, which is a bug in the host, and names every problem", () => {
		const wrong = { requestId: "delivery-2", tokens: { [ready.id]: ["j9"], [placeId("lost")]: ["j1"] } };
		expect(() => admit(contested, viewOf(initialState), wrong, 9)).toThrow(
			new Error(
				'invalid batch delivery-2: marking: "j9" on ready is not in Job; marking: place lost is not in the net',
			),
		);
	});
});
