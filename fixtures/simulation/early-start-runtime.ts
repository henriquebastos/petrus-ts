// Planted defect: invoke the native worker before its allocation commit can land.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { admit } from "../../packages/runtime/src/admit.ts";
import { commitToNetInstance } from "../../packages/runtime/src/net-instance-commit.ts";
import { nativeFixture } from "./native-fixture.ts";
import type { Worker } from "./native-fixture.ts";

export function createEarlyStartRuntime(options: RuntimeOptions): Runtime {
	const { runtime, parts } = nativeFixture(options);
	return { ...runtime, instance: (host, conversationId) => ({
		...runtime.instance(host, conversationId),
		enqueue: (batch, context) => host.commit((tx) => {
			const at = options.clock.now();
			return commitToNetInstance(tx, conversationId, { ...parts,
				start: async (transaction, conversation, operation, startedAt) => {
					const registered = options.executions?.find(({ transition }) => transition.id === operation.transition);
					const worker = registered?.extension.tasks?.[0] as Worker | undefined;
					const run = worker?.definition.phases.run;
					if (run !== undefined) {
						// Only the external call is exercised. Its attempted state changes are deliberately discarded.
						const running = { input: { ...operation, startedAt } } as Parameters<typeof run>[0];
						const earlyRuntime = { now: options.clock.now, signal: new AbortController().signal,
							commit: () => Promise.resolve(), sleepUntil: () => Promise.resolve() } as unknown as Parameters<typeof run>[1];
						await run(running, earlyRuntime, context).catch(() => undefined);
					}
					return parts.start(transaction, conversation, operation, startedAt);
				},
			}, (current) => admit(runtime.net, current, batch, at), at);
		}, context),
	}) };
}
