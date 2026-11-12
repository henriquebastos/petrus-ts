import fc from "fast-check";
import type { Net, Place, Transition } from "@petrus/petri-net";
import { placeId, transitionId } from "@petrus/petri-net";
import { expect, test } from "vitest";
import { recordProducerConsumer } from "../src/record-producer-consumer.ts";
import { recordDiningPhilosophers } from "../src/record-dining-philosophers.ts";
import { recordRun } from "../src/record-run.ts";
import { initialMarking, orderProcess, orderProcessHandlers } from "../src/order-process.ts";
import { readRecording, projectNet } from "@petrus/net-view-model";
import { replay } from "@petrus/runtime-replay";

test("records plain authored transitions through the runtime's expanded start and end net", async () => {
	const recording = await recordRun(
		"Order",
		orderProcess,
		orderProcessHandlers({
			reserve: () => Promise.resolve(true),
			charge: () => Promise.resolve(true),
			undo: () => Promise.resolve(),
		}),
		initialMarking(["o1"]),
		{ now: () => 0 },
	);
	expect(recording.committedMarking).toStrictEqual({ Done: [["o1", "shipped"]] });
	expect(recording.frames.at(-1)?.marking).toStrictEqual(recording.committedMarking);
	expect(recording.nodes.map(({ name }) => name)).toEqual(
		expect.arrayContaining(["Split:busy", "Ship:busy", "Split:done", "Ship:done"]),
	);
	expect(recording.frames.filter(({ kind }) => kind === "occurrence")).toHaveLength(8);
	expect(recording.frames.some((frame) => frame.marking["Split:busy"]?.length === 1)).toBe(true);
});

test("records dining philosophers through the same replay contract", async () => {
	let time = 0;
	const recording = await recordDiningPhilosophers({ now: () => time++ });
	expect(recording.frames.at(-1)?.marking).toStrictEqual(recording.committedMarking);
	expect(recording.committedMarking.fed?.slice().sort()).toStrictEqual(["p0", "p1", "p2", "p3", "p4"]);
	expect(recording.committedMarking.forks?.slice().sort()).toStrictEqual(["f0", "f1", "f2", "f3", "f4"]);
	expect(recording.frames.filter(({ kind }) => kind === "occurrence")).toHaveLength(10);
	expect(recording.nodes.map(({ name }) => name)).toContain("eat:busy");
});

test("records real handler runs with conserved slots and the committed final tokens", async () => {
	await fc.assert(
		fc.asyncProperty(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 3 }), async (orders, capacity) => {
			let time = 0;
			const recording = await recordProducerConsumer(orders, capacity, { now: () => time++ });
			expect(readRecording(JSON.parse(JSON.stringify(recording)))).toStrictEqual(recording);
			expect(recording.nodes.filter(({ kind }) => kind === "place")).toHaveLength(8);
			expect(recording.nodes.filter(({ kind }) => kind === "transition")).toHaveLength(4);
			expect(recording.frames.filter(({ kind }) => kind === "occurrence")).toHaveLength(orders * 4);
			expect(recording.frames.filter(({ kind }) => kind === "ingress")).toHaveLength(orders * 2 + 1);
			const final = {
				free: Array.from({ length: capacity }, () => "slot"),
				used: Array.from({ length: orders }, (_, index) => `item ${String(index + 1)}`),
			};
			expect(recording.committedMarking).toStrictEqual(final);
			expect(recording.frames.at(-1)?.marking).toStrictEqual(final);
			for (const frame of recording.frames.slice(1)) {
				const count = (place: string): number => frame.marking[place]?.length ?? 0;
				expect(count("free") + count("produce:busy") + count("buffer") + count("consume:busy")).toBe(capacity);
				expect(
					count("orders") + count("produce:busy") + count("buffer") + count("consume:busy") + count("used"),
				).toBe(orders);
			}
		}),
		{ numRuns: 12 },
	);
});

const place: Place = { id: placeId("same"), colourSet: { name: "JSON", contains: () => true } };
const transition: Transition<"x"> = {
	id: transitionId("same"),
	variables: { x: place.colourSet },
	guard: () => true,
	inputs: [{ place, variables: ["x"] }],
	outputs: [{ place, expression: ({ x }) => [{ previous: x }] }],
};
const net: Net = { places: [place], transitions: [transition] };

test("replay preserves duplicate token values and equal-count replacements", () => {
	const token = fc.oneof(
		fc.string(),
		fc.integer(),
		fc.boolean(),
		fc.constant(null),
		fc.array(fc.integer()),
		fc.record({ left: fc.integer(), right: fc.array(fc.string()) }),
	);
	fc.assert(
		fc.property(token, (value) => {
			const frames = replay(net, [
				{ kind: "ingress", requestId: "start", tokens: { [place.id]: [value, value] }, at: 0 },
				{ kind: "occurrence", transition: transition.id, binding: { x: value }, at: 0 },
			]);
			expect(frames[1]?.marking.same).toStrictEqual([value, value]);
			expect(frames[2]?.marking.same).toStrictEqual([value, { previous: value }]);
			expect(frames[2]?.binding).toStrictEqual({ x: value });
		}),
	);
});

test("projection preserves parallel arcs and separates place IDs from transition IDs", () => {
	const projected = projectNet({
		places: [place],
		transitions: [{ ...transition, inputs: [...transition.inputs, { place, expression: () => [] }] }],
	});
	const ids = projected.nodes.map(({ id }) => id);
	expect(new Set(ids).size).toBe(2);
	expect(projected.arcs.map(({ label }) => label)).toStrictEqual(["x", "expression", "expression"]);
	expect(new Set(projected.arcs.map(({ id }) => id)).size).toBe(3);
	expect(projected.arcs.every(({ source, target }) => ids.includes(source) && ids.includes(target))).toBe(true);
});

test("replay rejects an unknown transition or a firing without its required tokens", () => {
	expect(() => replay(net, [{ kind: "occurrence", transition: transitionId("missing"), binding: {}, at: 0 }])).toThrow(
		"Unknown transition",
	);
	expect(() =>
		replay(net, [{ kind: "occurrence", transition: transition.id, binding: { x: "absent" }, at: 0 }]),
	).toThrow("Cannot replay");
});
