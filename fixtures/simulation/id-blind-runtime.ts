// Planted defect: an enqueue ignores the request ids that the log holds, so a host that sends a batch again after a
// crash, as it must when it cannot tell whether the batch landed, adds its tokens twice.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime } from "../../packages/runtime/src/index.ts";
import { admit } from "../../packages/runtime/src/admit.ts";
import { createNetInstanceCache } from "../../packages/runtime/src/net-instance-cache.ts";
import type { NetInstanceParts } from "../../packages/runtime/src/net-instance-commit.ts";
import { commitToNetInstance } from "../../packages/runtime/src/net-instance-commit.ts";

export function createIdBlindRuntime(options: RuntimeOptions): Runtime {
	const runtime = createRuntime(options);
	const parts: NetInstanceParts = {
		name: options.name,
		cache: createNetInstanceCache(`${options.nonce}:fixture`),
		net: options.net,
		policy: options.policy,
		handlerIds: new Set(),
		start: () => Promise.resolve(),
	};
	return {
		extension: runtime.extension,
		instance: (host, conversationId) => ({
			...runtime.instance(host, conversationId),
			enqueue: (batch, context) => {
				const at = options.clock.now();
				return host.commit(
					(tx) =>
						commitToNetInstance(
							tx,
							conversationId,
							parts,
							(current) => admit(options.net, { ...current, ingressOf: () => undefined }, batch, at),
							at,
						),
					context,
				);
			},
		}),
	};
}
