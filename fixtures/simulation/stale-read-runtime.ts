// Planted defect: an enqueue reads the committed state outside its commit, then commits a change made from that
// read. Two enqueues that run at once both start from the same state, so the later commit drops the earlier batch.
import type { NetInstanceState, Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime } from "../../packages/runtime/src/index.ts";
import { admit } from "../../packages/runtime/src/admit.ts";
import { netInstanceRecord, writeNetInstance } from "../../packages/runtime/src/net-instance-record.ts";
import type { NetInstanceParts } from "../../packages/runtime/src/net-instance-commit.ts";
import { checkedState, plan } from "../../packages/runtime/src/net-instance-commit.ts";

export function createStaleReadRuntime(options: RuntimeOptions): Runtime {
	const runtime = createRuntime(options);
	const parts: NetInstanceParts = {
		name: options.name,
		net: options.net,
		policy: options.policy,
		handlerIds: new Set(),
		start: () => Promise.resolve(),
	};
	return {
		extension: runtime.extension,
		instance: (host, conversationId) => ({
			...runtime.instance(host, conversationId),
			enqueue: async (batch, context) => {
				const at = options.clock.now();
				const stored = await host.snapshot(netInstanceRecord, conversationId, context);
				const read: NetInstanceState = stored === undefined ? { marking: {}, log: [] } : checkedState(parts, stored);
				const planned = plan(parts, read, admit(options.net, read, batch, at), at);
				return host.commit(async (tx) => {
					const draft = await tx.doc(netInstanceRecord, conversationId);
					if (planned.kind === "applied") {
						writeNetInstance(draft, options.name, read, planned.state);
					}
					return { ingress: planned.ingress, fired: planned.kind === "applied" ? planned.fired : [] };
				}, context);
			},
		}),
	};
}
