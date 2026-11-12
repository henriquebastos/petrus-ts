// Planted defect: admission lands before allocation. A crash leaves enabled inputs in the committed net.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { admit } from "../../packages/runtime/src/admit.ts";
import { indexMarking } from "../../packages/petri-net/src/index.ts";
import { advanceOperations } from "../../packages/runtime/src/advance.ts";
import { netInstanceRecord, writeNetInstance } from "../../packages/runtime/src/net-instance-record.ts";
import { checkedState } from "../../packages/runtime/src/net-instance-commit.ts";
import { viewOf } from "../../packages/runtime/src/net-instance-view.ts";
import { operationsStartedFrom } from "../../packages/runtime/src/operations.ts";
import { nativeFixture } from "./native-fixture.ts";

export function createSplitCommitRuntime(options: RuntimeOptions): Runtime {
	const { runtime, parts } = nativeFixture(options);
	return { ...runtime, instance: (host, conversationId) => ({
		...runtime.instance(host, conversationId),
		enqueue: async (batch, context) => {
			const at = options.clock.now();
			const ingress = await host.commit(async (tx) => {
				const draft = await tx.doc(netInstanceRecord, conversationId);
				const admitted = admit(runtime.net, viewOf(checkedState(parts, draft)), batch, at);
				if (admitted.kind === "applied") {
					draft.stamp = "";
					writeNetInstance(draft, options.name, admitted.indexed.journal, [admitted.ingress]);
				}
				return admitted.ingress;
			}, context);
			const fired = await host.commit(async (tx) => {
				const draft = await tx.doc(netInstanceRecord, conversationId);
				const state = checkedState(parts, draft);
				const stepped = advanceOperations(options.policy, indexMarking(runtime.net, state.marking), at, parts.handlerIds,
					draft.budget ?? { ceiling: options.startLimit, used: 0, paused: false });
				draft.budget = stepped.budget;
				draft.stamp = "";
				writeNetInstance(draft, options.name, stepped.indexed.journal, stepped.fired);
				for (const operation of operationsStartedFrom(parts.handlerIds, stepped.fired, state.log.length)) {
					await parts.start(tx, conversationId, operation, at);
				}
				return stepped.fired;
			}, context);
			return { ingress, fired };
		},
	}) };
}
