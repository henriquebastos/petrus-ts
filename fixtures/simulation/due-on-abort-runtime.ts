// Planted defect: aborting a task that sleeps on a delayed result records that result, so a marked abort ends its
// operation as if the work were done.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime, withHandlers } from "../../packages/runtime/src/index.ts";
import { createOperationRun } from "../../packages/runtime/src/operation-run.ts";
import { commitToNetInstance } from "../../packages/runtime/src/net-instance-commit.ts";
import { admitResult } from "../../packages/runtime/src/operations.ts";

export function createDueOnAbortRuntime(options: RuntimeOptions): Runtime {
	const runtime = createRuntime(options);
	const handlers = options.handlers ?? [];
	const net = withHandlers(options.net, handlers.map((handler) => handler.transition));
	const handlerIds = new Set(handlers.map((handler) => handler.transition.id));
	const real = createOperationRun({ ...options, net, handlerIds, handlers });
	const task: typeof real.task = {
		definition: {
			...real.task.definition,
			abort: async (running, taskRuntime, context) => {
				const { checkpoint } = running.state;
				if (checkpoint.phase !== "due") {
					return real.task.definition.abort(running, taskRuntime, context);
				}
				await taskRuntime.commit(async (tx) => {
					const at = taskRuntime.now();
					await commitToNetInstance(tx, taskRuntime.conversationId, real.parts, (view) => admitResult(net, handlerIds, view, running.input.id, checkpoint.result, at), at);
					return { status: "terminal", outcome: { status: "aborted" } };
				}, context);
			},
		},
	};
	return { extension: { name: runtime.extension.name, tasks: [task] }, instance: runtime.instance };
}
