// Planted defect: when a delay ends, the due phase ends the task as completed but does not record the result, so
// the operation stays in flight for ever and its tokens never come back.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime, withHandlers } from "../../packages/runtime/src/index.ts";
import { createOperationRun } from "../../packages/runtime/src/operation-run.ts";
import { createNetInstanceCache } from "../../packages/runtime/src/net-instance-cache.ts";

export function createLostDueRuntime(options: RuntimeOptions): Runtime {
	const runtime = createRuntime(options);
	const handlers = options.handlers ?? [];
	const net = withHandlers(options.net, handlers.map((handler) => handler.transition));
	const handlerIds = new Set(handlers.map((handler) => handler.transition.id));
	const real = createOperationRun({ ...options, cache: createNetInstanceCache(`${options.nonce}:fixture`), net, handlerIds, handlers });
	const task: typeof real.task = {
		definition: {
			...real.task.definition,
			phases: {
				...real.task.definition.phases,
				due: (running, taskRuntime, context) =>
					taskRuntime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: running.state.checkpoint.result } }),
						context,
					),
			},
		},
	};
	return { extension: { name: runtime.extension.name, tasks: [task] }, instance: runtime.instance };
}
