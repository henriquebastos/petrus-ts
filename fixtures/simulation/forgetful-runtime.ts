// Planted defect: an enqueue plans its commit and returns what the plan fired, but writes nothing, so storage never
// holds a batch that the host was told landed.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { nativeFixture } from "./native-fixture.ts";
import { admit } from "../../packages/runtime/src/admit.ts";
import { netInstanceRecord } from "../../packages/runtime/src/net-instance-record.ts";
import { checkedState, plan } from "../../packages/runtime/src/net-instance-commit.ts";
import { viewOf } from "../../packages/runtime/src/net-instance-view.ts";

export function createForgetfulRuntime(options: RuntimeOptions): Runtime {
	const { runtime, parts } = nativeFixture(options);
	return {
		net: runtime.net,
		extension: runtime.extension,
		instance: (host, conversationId) => ({
			...runtime.instance(host, conversationId),
			enqueue: (batch, context) =>
				host.commit(async (tx) => {
					const at = options.clock.now();
					const view = viewOf(checkedState(parts, await tx.doc(netInstanceRecord, conversationId)));
					const planned = plan(parts, view, admit(runtime.net, view, batch, at), at);
					return { ingress: planned.ingress, fired: planned.kind === "applied" ? planned.fired : [] };
				}, context),
		}),
	};
}
