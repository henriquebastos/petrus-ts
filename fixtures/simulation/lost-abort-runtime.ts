// Planted defect: an aborted task ends without its result, as before aborts had a variant, so the operation stays
// in flight for ever and its slot never comes back.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime, withHandlers } from "../../packages/runtime/src/index.ts";
import { createOperationRun } from "../../packages/runtime/src/operation-run.ts";
import { createNetInstanceCache } from "../../packages/runtime/src/net-instance-cache.ts";

export function createLostAbortRuntime(options: RuntimeOptions): Runtime {
	const runtime = createRuntime(options);
	const handlers = options.handlers ?? [];
	const net = withHandlers(options.net, handlers.map((handler) => handler.transition));
	const handlerIds = new Set(handlers.map((handler) => handler.transition.id));
	const real = createOperationRun({ ...options, cache: createNetInstanceCache(`${options.nonce}:fixture`), net, handlerIds, handlers });
	const task: typeof real.task = {
		definition: {
			...real.task.definition,
			abort: (_running, taskRuntime, context) =>
				taskRuntime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
		},
	};
	return { extension: { name: runtime.extension.name, tasks: [task] }, instance: runtime.instance };
}
