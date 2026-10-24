// Planted defect: a step runs the handlers of the operations it starts before its commit lands, so the outside
// service does work for a firing that a crash can still undo.
import type { Runtime, RuntimeOptions, Stepped } from "../../packages/runtime/src/index.ts";
import { withHandlers } from "../../packages/runtime/src/index.ts";
import { advance } from "../../packages/runtime/src/advance.ts";
import { startedOperations } from "../../packages/runtime/src/operations.ts";
import { createRuntime } from "../../packages/runtime/src/runtime.ts";
import { createSerialQueue } from "../../packages/runtime/src/serial-queue.ts";
import { createSettle } from "../../packages/runtime/src/settle.ts";

export function createEarlyStartRuntime(options: RuntimeOptions): Runtime {
	const runtime = createRuntime(options);
	const handlers = options.handlers ?? [];
	const net = withHandlers(options.net, handlers.map((handler) => handler.transition));
	const ids = new Set(handlers.map((handler) => handler.transition.id));
	const serial = createSerialQueue();
	const stepNow = async (): Promise<Stepped> => {
		const state = await options.store.load();
		const stepped = advance(net, options.policy, state, options.clock.now());
		for (const operation of startedOperations(ids, stepped.state.log).slice(startedOperations(ids, state.log).length)) {
			const handler = handlers.find((candidate) => candidate.transition.id === operation.transition);
			// The early run only shows the defect; its result and its errors are dropped.
			void handler?.run(operation.binding, { operationId: operation.id }).catch(() => undefined);
		}
		if (stepped.state !== state) {
			await options.store.commit(stepped.state);
		}
		return stepped;
	};
	const parts = {
		step: () => serial(stepNow),
		inFlight: () => serial(runtime.inFlight),
		complete: (id: string, result: Parameters<Runtime["complete"]>[1]) => serial(() => runtime.complete(id, result)),
	};
	return { ...runtime, ...parts, settle: createSettle(parts, handlers) };
}
