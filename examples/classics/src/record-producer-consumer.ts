import type { Clock } from "@petrus/runtime";
import type { Recording } from "@petrus/net-view-model";
import { initialMarking, producerConsumer, producerConsumerHandlers } from "./producer-consumer.ts";
import { recordRun } from "./record-run.ts";

/** Records the classical bounded buffer with a local workshop. */
export function recordProducerConsumer(orders: number, capacity: number, clock: Clock): Promise<Recording> {
	const handlers = producerConsumerHandlers({
		make: (order) => Promise.resolve(typeof order === "string" ? order.replace("order", "item") : order),
		use: () => Promise.resolve(),
	});
	return recordRun("Producer & consumer", producerConsumer, handlers, initialMarking(orders, capacity), clock);
}
