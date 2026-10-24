// Planted defect: a delay counts from the handler's run, not from the start of its operation, so after a crash
// and an outage the rerun's wait starts again and the result comes late.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime, withHandlers } from "../../packages/runtime/src/index.ts";
import { createOperationRun } from "../../packages/runtime/src/operation-run.ts";

export function createFromRunRuntime(options: RuntimeOptions): Runtime {
	const runtime = createRuntime(options);
	const handlers = options.handlers ?? [];
	const net = withHandlers(options.net, handlers.map((handler) => handler.transition));
	const handlerIds = new Set(handlers.map((handler) => handler.transition.id));
	const real = createOperationRun({ ...options, net, handlerIds, handlers });
	const { phases } = real.task.definition;
	const task: typeof real.task = {
		definition: {
			...real.task.definition,
			phases: {
				...phases,
				run: (running, taskRuntime, context) =>
					phases.run({ ...running, input: { ...running.input, startedAt: taskRuntime.now() } }, taskRuntime, context),
			},
		},
	};
	return { extension: { name: runtime.extension.name, tasks: [task] }, instance: runtime.instance };
}
