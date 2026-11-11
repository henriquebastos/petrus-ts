// Planted defect: an enqueue commits its steps first and creates the tasks of the operations they started in a
// second commit, so a crash between the two leaves operations in flight that no task will ever run.
import type { Operation, Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime, withHandlers } from "../../packages/runtime/src/index.ts";
import { admit } from "../../packages/runtime/src/admit.ts";
import { createOperationRun } from "../../packages/runtime/src/operation-run.ts";
import { createNetInstanceCache } from "../../packages/runtime/src/net-instance-cache.ts";
import type { NetInstanceParts } from "../../packages/runtime/src/net-instance-commit.ts";
import { commitToNetInstance } from "../../packages/runtime/src/net-instance-commit.ts";

export function createLateTaskRuntime(options: RuntimeOptions): Runtime {
	const runtime = createRuntime(options);
	const handlers = options.handlers ?? [];
	const net = withHandlers(options.net, handlers.map((handler) => handler.transition));
	const handlerIds = new Set(handlers.map((handler) => handler.transition.id));
	const cache = createNetInstanceCache(`${options.nonce}:fixture`);
	const { start } = createOperationRun({ ...options, cache, net, handlerIds, handlers }).parts;
	return {
		extension: runtime.extension,
		instance: (host, conversationId) => ({
			...runtime.instance(host, conversationId),
			enqueue: async (batch, context) => {
				const at = options.clock.now();
				const started: Operation[] = [];
				const parts: NetInstanceParts = {
					name: options.name,
					cache,
					net,
					policy: options.policy,
					handlerIds,
					start: (_tx, _conversationId, operation) => {
						started.push(operation);
						return Promise.resolve();
					},
				};
				const committed = await host.commit(
					(tx) => commitToNetInstance(tx, conversationId, parts, (current) => admit(net, current, batch, at), at),
					context,
				);
				await host.commit(async (tx) => {
					for (const operation of started) {
						await start(tx, conversationId, operation, at);
					}
				}, context);
				return committed;
			},
		}),
	};
}
