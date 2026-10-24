// Planted defect: a result is recorded under a request id made from the time, not from the operation. The log then
// has no result under the operation's id, and after a lost reply the operation runs again and adds a second result.
import type { HandlerResult, Ingress, Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { resultPlaceId, withHandlers } from "../../packages/runtime/src/index.ts";
import { admit } from "../../packages/runtime/src/admit.ts";
import { resultToken } from "../../packages/runtime/src/handlers.ts";
import { startedOperations } from "../../packages/runtime/src/operations.ts";
import { createRuntime } from "../../packages/runtime/src/runtime.ts";
import { createSerialQueue } from "../../packages/runtime/src/serial-queue.ts";
import { createSettle } from "../../packages/runtime/src/settle.ts";

export function createTimedResultRuntime(options: RuntimeOptions): Runtime {
	const runtime = createRuntime(options);
	const handlers = options.handlers ?? [];
	const net = withHandlers(options.net, handlers.map((handler) => handler.transition));
	const ids = new Set(handlers.map((handler) => handler.transition.id));
	const serial = createSerialQueue();
	let time = 0;
	const completeNow = async (operationId: string, result: HandlerResult): Promise<Ingress> => {
		const state = await options.store.load();
		const operation = startedOperations(ids, state.log).find((started) => started.id === operationId);
		if (operation === undefined) {
			throw new Error(`no operation ${operationId}`);
		}
		time += 1;
		const tokens = { [resultPlaceId(operation.transition)]: [resultToken(operation.binding, result)] };
		const admitted = admit(net, state, { requestId: `${operationId}@${String(time)}`, tokens }, time);
		if (admitted.kind === "applied") {
			await options.store.commit(admitted.state);
		}
		return admitted.ingress;
	};
	const parts = {
		step: () => serial(runtime.step),
		inFlight: () => serial(runtime.inFlight),
		complete: (id: string, result: HandlerResult) => serial(() => completeNow(id, result)),
	};
	return { ...runtime, ...parts, settle: createSettle(parts, handlers) };
}
