import fc from "fast-check";
import type { Marking, Token } from "@petrus/petri-net";
import { definitionOrder, tokensAt } from "@petrus/petri-net";
import type { Runtime } from "@petrus/runtime";
import { busyPlaceId, createRuntime } from "@petrus/runtime";
import { describe, expect, test } from "vitest";
import type { Workshop } from "../src/producer-consumer.ts";
import {
	buffer,
	consume,
	free,
	initialMarking,
	orders,
	produce,
	producerConsumer,
	producerConsumerHandlers,
	used,
} from "../src/producer-consumer.ts";
import { clock, createDisk, runToEnd } from "./disk.ts";

/** A workshop that does each operation once and records it. `pause` is where its work waits. */
function workshop(pause: () => Promise<void>): Workshop & { readonly uses: () => ReadonlyMap<string, Token> } {
	const made = new Map<string, Token>();
	const uses = new Map<string, Token>();
	return {
		make: async (order, operationId) => {
			await pause();
			const item = made.get(operationId) ?? (typeof order === "string" ? order.replace("order", "item") : order);
			made.set(operationId, item);
			return item;
		},
		use: async (item, operationId) => {
			await pause();
			uses.set(operationId, item);
		},
		uses: () => uses,
	};
}

function runtimeOf(shop: Workshop): Runtime {
	return createRuntime({
		name: "producer-consumer",
		net: producerConsumer,
		policy: definitionOrder,
		clock,
		handlers: producerConsumerHandlers(shop),
		retryDelayMs: 0,
	});
}

/** The slots are conserved, and each order is in exactly one stage. */
function invariantsHold(marking: Marking, orderCount: number, capacity: number): boolean {
	const inProduction = tokensAt(marking, busyPlaceId(produce.id)).length;
	const inUse = tokensAt(marking, busyPlaceId(consume.id)).length;
	const stored = tokensAt(marking, buffer.id).length;
	return (
		tokensAt(marking, free.id).length + inProduction + stored + inUse === capacity &&
		tokensAt(marking, orders.id).length + inProduction + stored + inUse + tokensAt(marking, used.id).length ===
			orderCount
	);
}

describe("producer and consumer", () => {
	test("makes and uses every order once, and frees every slot", async () => {
		const disk = createDisk();
		const shop = workshop(() => Promise.resolve());
		await runToEnd(disk, runtimeOf(shop), initialMarking(3, 2), undefined);
		expect(disk.last()).toStrictEqual({
			[free.id]: ["slot", "slot"],
			[used.id]: ["item 1", "item 2", "item 3"],
		});
		expect([...shop.uses().values()].sort()).toStrictEqual(["item 1", "item 2", "item 3"]);
	});

	test("keeps the buffer bounded and each order in one stage at every commit, under any order of work and a crash at any commit", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.scheduler(),
				fc.integer({ min: 1, max: 5 }),
				fc.integer({ min: 1, max: 3 }),
				fc.option(fc.nat({ max: 24 }), { nil: undefined }),
				async (scheduler, orderCount, capacity, crashAt) => {
					const disk = createDisk();
					const shop = workshop(() => scheduler.schedule(Promise.resolve(), "work"));
					await runToEnd(disk, runtimeOf(shop), initialMarking(orderCount, capacity), crashAt, (settling) =>
						scheduler.waitFor(settling),
					);
					const items = Array.from({ length: orderCount }, (_, index) => `item ${String(index + 1)}`);
					return (
						disk.history().every((state) => invariantsHold(state, orderCount, capacity)) &&
						tokensAt(disk.last(), free.id).length === capacity &&
						JSON.stringify([...tokensAt(disk.last(), used.id)].sort()) === JSON.stringify(items) &&
						JSON.stringify([...shop.uses().values()].sort()) === JSON.stringify(items)
					);
				},
			),
		);
	});
});
