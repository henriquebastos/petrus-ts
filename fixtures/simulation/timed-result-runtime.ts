// Planted defect: an operation run records its result under a request id made from the time, not the operation's
// `result:<id>`, so the log cannot tell which operation a result ends, and a second run would add a second result.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime, resultPlaceId, withHandlers } from "../../packages/runtime/src/index.ts";
import { transitionId } from "../../packages/petri-net/src/index.ts";
import { admit } from "../../packages/runtime/src/admit.ts";
import { json } from "../../packages/runtime/src/net-instance-record.ts";
import { createOperationRun } from "../../packages/runtime/src/operation-run.ts";
import { resultToken } from "../../packages/runtime/src/handlers.ts";
import type { NetInstanceParts } from "../../packages/runtime/src/net-instance-commit.ts";
import { commitToNetInstance } from "../../packages/runtime/src/net-instance-commit.ts";

export function createTimedResultRuntime(options: RuntimeOptions): Runtime {
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
					try {
						const result = await handler!.run(binding, { operationId: id });
						if ("delayMs" in result) {
							throw new Error("this planted defect runs no delayed result");
						}
						await taskRuntime.commit(async (tx) => {
							const at = taskRuntime.now();
							const tokens = { [resultPlaceId(transition)]: [resultToken(binding, result)] };
							const requestId = `${id}@${String(at)}`;
							await commitToNetInstance(tx, taskRuntime.conversationId, parts, (state) => admit(net, state, { requestId, tokens }, at), at);
							return { status: "terminal", outcome: { status: "completed", result: { variant: result.variant, value: json(result.value) } } };
						}, context);
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
