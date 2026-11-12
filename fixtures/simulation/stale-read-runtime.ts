// Planted defect: an enqueue reads the committed state outside its commit, then commits a change made from that
// read. Two enqueues that run at once both start from the same state, so the later commit drops the earlier batch.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { nativeFixture } from "./native-fixture.ts";
import { admit } from "../../packages/runtime/src/admit.ts";
import { netInstanceRecord, writeNetInstance } from "../../packages/runtime/src/net-instance-record.ts";
import { checkedState, plan } from "../../packages/runtime/src/net-instance-commit.ts";
import { viewOf } from "../../packages/runtime/src/net-instance-view.ts";

export function createStaleReadRuntime(options: RuntimeOptions): Runtime {
	const { runtime, parts } = nativeFixture(options);
	return {
		net: runtime.net,
		extension: runtime.extension,
		instance: (host, conversationId) => ({
			...runtime.instance(host, conversationId),
			enqueue: async (batch, context) => {
				const at = options.clock.now();
				const stored = await host.snapshot(netInstanceRecord, conversationId, context);
				const read = viewOf(stored === undefined ? { marking: {}, log: [] } : checkedState(parts, stored));
				const planned = plan(parts, read, admit(runtime.net, read, batch, at), at, stored?.budget);
				return host.commit(async (tx) => {
					const draft = await tx.doc(netInstanceRecord, conversationId);
					if (planned.kind === "applied") {
						draft.marking = stored?.marking ?? {};
						draft.budget = planned.budget;
						draft.stamp = "";
						writeNetInstance(draft, options.name, planned.indexed.journal, planned.appended);
						for (const operation of planned.started) await parts.start(tx, conversationId, operation, at);
					}
					return { ingress: planned.ingress, fired: planned.kind === "applied" ? planned.fired : [] };
				}, context);
			},
		}),
	};
}
