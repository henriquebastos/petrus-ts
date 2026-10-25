// Planted defect: an operation run does not catch a throw, so a handler's outage ends the task as faulted
// and its operation stays in flight for ever, holding the job and its slot.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime, withHandlers } from "../../packages/runtime/src/index.ts";
import { transitionId } from "../../packages/petri-net/src/index.ts";
import { json } from "../../packages/runtime/src/net-instance-record.ts";
import { createOperationRun } from "../../packages/runtime/src/operation-run.ts";
import type { NetInstanceParts } from "../../packages/runtime/src/net-instance-commit.ts";
import { commitToNetInstance } from "../../packages/runtime/src/net-instance-commit.ts";
import { admitResult } from "../../packages/runtime/src/operations.ts";

export function createUncaughtThrowRuntime(options: RuntimeOptions): Runtime {
	const runtime = createRuntime(options);
	const handlers = options.handlers ?? [];
	const net = withHandlers(options.net, handlers.map((handler) => handler.transition));
	const handlerIds = new Set(handlers.map((handler) => handler.transition.id));
	const real = createOperationRun({ ...options, net, handlerIds, handlers });
	const parts: NetInstanceParts = { name: options.name, net, policy: options.policy, handlerIds, start: real.parts.start };
	const task: typeof real.task = {
		definition: {
			...real.task.definition,
			phases: {
				...real.task.definition.phases,
				run: async (running, taskRuntime, context) => {
					const { id, binding } = running.input;
					const transition = transitionId(running.input.transition);
					const handler = handlers.find((candidate) => candidate.transition.id === transition);
					const result = await handler!.run(binding, { operationId: id, signal: taskRuntime.signal });
					if ("delayMs" in result) {
						throw new Error("this planted defect runs no delayed result");
					}
					await taskRuntime.commit(async (tx) => {
						const at = taskRuntime.now();
						await commitToNetInstance(tx, taskRuntime.conversationId, parts, (state) => admitResult(net, handlerIds, state, id, result, at), at);
						return { status: "terminal", outcome: { status: "completed", result: { variant: result.variant, value: json(result.value) } } };
					}, context);
				},
			},
		},
	};
	return { extension: { name: runtime.extension.name, tasks: [task] }, instance: runtime.instance };
}
