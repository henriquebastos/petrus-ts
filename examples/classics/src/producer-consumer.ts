import type { ColourSet, Marking, Net, Place, Token } from "@petrus/petri-net";
import { placeId, transitionId } from "@petrus/petri-net";
import type { Handler, HandlerTransition } from "@petrus/runtime";

/**
 * A producer and a consumer that share a buffer with room for `capacity` items. Each free slot is a token on
 * `free`. Producing an item takes an order and a slot; the item holds the slot until it is used, and using it gives
 * the slot back. So `free + produce:busy + buffer + consume:busy = capacity` at every commit.
 */
const order: ColourSet = { name: "Order", contains: (token) => typeof token === "string" && /^order \d+$/.test(token) };
const item: ColourSet = { name: "Item", contains: (token) => typeof token === "string" && /^item \d+$/.test(token) };
const slot: ColourSet = { name: "Slot", contains: (token) => token === "slot" };

export const orders: Place = { id: placeId("orders"), colourSet: order };
export const free: Place = { id: placeId("free"), colourSet: slot };
export const buffer: Place = { id: placeId("buffer"), colourSet: item };
export const used: Place = { id: placeId("used"), colourSet: item };

/** The producer's work: make the item for one order. The slot stays taken, by the run and then by the item. */
export const produce: HandlerTransition<"order" | "slot"> = {
	id: transitionId("produce"),
	variables: { order, slot },
	guard: () => true,
	inputs: [
		{ place: orders, variables: ["order"] },
		{ place: free, variables: ["slot"] },
	],
	variants: { made: { value: item, outputs: [{ place: buffer, expression: (_binding, value) => [value] }] } },
};

/** The consumer's work: use one item. Then its slot is free again. */
export const consume: HandlerTransition<"item"> = {
	id: transitionId("consume"),
	variables: { item },
	guard: () => true,
	inputs: [{ place: buffer, variables: ["item"] }],
	variants: {
		done: {
			value: item,
			outputs: [
				{ place: used, expression: ({ item: done }) => [done] },
				{ place: free, expression: () => ["slot"] },
			],
		},
	},
};

/** The net without its handler transitions; the runtime adds them from `handlers`. */
export const producerConsumer: Net = { places: [orders, free, buffer, used], transitions: [] };

/** `orderCount` orders, numbered from 1, and `capacity` free slots. */
export function initialMarking(orderCount: number, capacity: number): Marking {
	return {
		[orders.id]: Array.from({ length: orderCount }, (_, index) => `order ${String(index + 1)}`),
		[free.id]: Array.from({ length: capacity }, () => "slot"),
	};
}

/**
 * The services outside the net. Each call gets the operation id, so that a second run of one operation, after a
 * crash, finds what the first run did and does not do it again.
 */
export type Workshop = {
	/** Makes the item for an order: `item n` for `order n`. */
	readonly make: (order: Token, operationId: string) => Promise<Token>;
	readonly use: (item: Token, operationId: string) => Promise<void>;
};

export function producerConsumerHandlers(workshop: Workshop): readonly Handler[] {
	const producer: Handler<"order" | "slot"> = {
		transition: produce,
		run: async (binding, { operationId }) => ({
			variant: "made",
			value: await workshop.make(binding.order, operationId),
		}),
	};
	const consumer: Handler<"item"> = {
		transition: consume,
		run: async (binding, { operationId }) => {
			await workshop.use(binding.item, operationId);
			return { variant: "done", value: binding.item };
		},
	};
	return [producer, consumer];
}
