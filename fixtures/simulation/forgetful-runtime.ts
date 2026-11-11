// Planted defect: an enqueue plans its commit and returns what the plan fired, but writes nothing, so storage never
// holds a batch that the host was told landed.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime } from "../../packages/runtime/src/index.ts";
import { admit } from "../../packages/runtime/src/admit.ts";
import { createNetInstanceCache } from "../../packages/runtime/src/net-instance-cache.ts";
import { netInstanceRecord } from "../../packages/runtime/src/net-instance-record.ts";
import type { NetInstanceParts } from "../../packages/runtime/src/net-instance-commit.ts";
import { checkedState, plan } from "../../packages/runtime/src/net-instance-commit.ts";
import { viewOf } from "../../packages/runtime/src/net-instance-view.ts";

export function createForgetfulRuntime(options: RuntimeOptions): Runtime {
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
			enqueue: (batch, context) =>
				host.commit(async (tx) => {
					const at = options.clock.now();
					const view = viewOf(checkedState(parts, await tx.doc(netInstanceRecord, conversationId)));
					const planned = plan(parts, view, admit(options.net, view, batch, at), at);
					return { ingress: planned.ingress, fired: planned.kind === "applied" ? planned.fired : [] };
				}, context),
		}),
	};
}
