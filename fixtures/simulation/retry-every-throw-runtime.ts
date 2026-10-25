// Planted defect: an operation run retries every throw, also a broken net instance that throws again on each run,
// so the task never ends: it reports the same bug after each retry delay, for ever.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime, withHandlers } from "../../packages/runtime/src/index.ts";
import { createOperationRun } from "../../packages/runtime/src/operation-run.ts";

export function createRetryEveryThrowRuntime(options: RuntimeOptions): Runtime {
	const runtime = createRuntime(options);
	const handlers = options.handlers ?? [];
	const net = withHandlers(options.net, handlers.map((handler) => handler.transition));
	const handlerIds = new Set(handlers.map((handler) => handler.transition.id));
	const real = createOperationRun({ ...options, net, handlerIds, handlers });
	const task: typeof real.task = {
		definition: {
			...real.task.definition,
			phases: {
				...real.task.definition.phases,
				run: async (running, taskRuntime, context) => {
					try {
						await real.task.definition.phases.run(running, taskRuntime, context);
					} catch (error: unknown) {
						taskRuntime.report(error);
						await taskRuntime.sleepUntil(taskRuntime.now() + options.retryDelayMs, { phase: "run" }, context);
					}
				},
			},
		},
	};
	return { extension: { name: runtime.extension.name, tasks: [task] }, instance: runtime.instance };
}
