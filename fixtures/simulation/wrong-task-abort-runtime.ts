// Planted defect: an abort takes the first live task of the net's operations, not the task of the operation it
// names, so with two operations in flight the other one ends as aborted.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime } from "../../packages/runtime/src/index.ts";

export function createWrongTaskAbortRuntime(options: RuntimeOptions): Runtime {
	const runtime = createRuntime(options);
	return {
		extension: runtime.extension,
		instance: (host, conversationId) => {
			const instance = runtime.instance(host, conversationId);
			return {
				...instance,
				abort: async (operationId, context) => {
					if (!(await instance.inFlight(context)).some((operation) => operation.id === operationId)) {
						return instance.abort(operationId, context);
					}
					const first = await host.commit(async (tx) => {
						const page = await tx.scanTasks({ conversationId, status: "running" }, 1);
						const sleeping = await tx.scanTasks({ conversationId, status: "sleeping" }, 1);
						const pending = await tx.scanTasks({ conversationId, status: "pending" }, 1);
						return [...page.items, ...sleeping.items, ...pending.items][0];
					}, context);
					return first === undefined ? instance.abort(operationId, context) : host.abortTask(first.id, context);
				},
			};
		},
	};
}
