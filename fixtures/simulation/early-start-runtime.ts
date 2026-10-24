// Planted defect: a commit runs the handler of each operation it starts before the commit lands, so the outside
// service does work for a firing that a crash can still undo.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime, withHandlers } from "../../packages/runtime/src/index.ts";
import { admit } from "../../packages/runtime/src/admit.ts";
import { createOperationRun } from "../../packages/runtime/src/operation-run.ts";
import type { NetInstanceParts, StartOperation } from "../../packages/runtime/src/net-instance-commit.ts";
import { commitToNetInstance } from "../../packages/runtime/src/net-instance-commit.ts";

export function createEarlyStartRuntime(options: RuntimeOptions): Runtime {
	const runtime = createRuntime(options);
	const handlers = options.handlers ?? [];
	const net = withHandlers(options.net, handlers.map((handler) => handler.transition));
	const handlerIds = new Set(handlers.map((handler) => handler.transition.id));
	const { start } = createOperationRun({ ...options, net, handlerIds, handlers }).parts;
	const earlyStart: StartOperation = (tx, conversationId, operation) => {
		const handler = handlers.find((candidate) => candidate.transition.id === operation.transition);
		// The early run only shows the defect; its result and its errors are dropped.
		void handler?.run(operation.binding, { operationId: operation.id }).catch(() => undefined);
		return start(tx, conversationId, operation);
	};
	const parts: NetInstanceParts = { name: options.name, net, policy: options.policy, handlerIds, start: earlyStart };
	return {
		extension: runtime.extension,
		instance: (host, conversationId) => ({
			...runtime.instance(host, conversationId),
			enqueue: (batch, context) => {
				const at = options.clock.now();
				return host.commit(
					(tx) => commitToNetInstance(tx, conversationId, parts, (current) => admit(net, current, batch, at), at),
					context,
				);
			},
		}),
	};
}
