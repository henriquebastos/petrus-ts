// Planted defect: an enqueue admits the batch in one commit and steps the net in a second, so a crash between them
// leaves a committed net that is not quiet.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime } from "../../packages/runtime/src/index.ts";
import { admit } from "../../packages/runtime/src/admit.ts";
import { advanceUntilQuiet } from "../../packages/runtime/src/advance.ts";
import { netInstanceRecord, writeNetInstance } from "../../packages/runtime/src/net-instance-record.ts";
import type { NetInstanceParts } from "../../packages/runtime/src/net-instance-commit.ts";
import { checkedState } from "../../packages/runtime/src/net-instance-commit.ts";

export function createSplitCommitRuntime(options: RuntimeOptions): Runtime {
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
				const ingress = await host.commit(async (tx) => {
					const draft = await tx.doc(netInstanceRecord, conversationId);
					const state = checkedState(parts, draft);
					const admitted = admit(options.net, state, batch, at);
					if (admitted.kind === "applied") {
						writeNetInstance(draft, options.name, state, admitted.state);
					}
					return admitted.ingress;
				}, context);
				const fired = await host.commit(async (tx) => {
					const draft = await tx.doc(netInstanceRecord, conversationId);
					const state = checkedState(parts, draft);
					const stepped = advanceUntilQuiet(options.net, options.policy, state, at);
					writeNetInstance(draft, options.name, state, stepped.state);
					return stepped.fired;
				}, context);
				return { ingress, fired };
			},
		}),
	};
}
