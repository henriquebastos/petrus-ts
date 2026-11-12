// Planted defect: allocation and coordinator creation land in separate commits.
import type { Operation, Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { admit } from "../../packages/runtime/src/admit.ts";
import { commitToNetInstance } from "../../packages/runtime/src/net-instance-commit.ts";
import { nativeFixture } from "./native-fixture.ts";

export function createLateTaskRuntime(options: RuntimeOptions): Runtime {
	const { runtime, parts } = nativeFixture(options);
	return { ...runtime, instance: (host, conversationId) => ({
		...runtime.instance(host, conversationId),
		enqueue: async (batch, context) => {
			const at = options.clock.now();
			const started: Operation[] = [];
			const committed = await host.commit((tx) => commitToNetInstance(tx, conversationId, {
				...parts, start: (_tx, _conversationId, operation) => { started.push(operation); return Promise.resolve(); },
			}, (current) => admit(runtime.net, current, batch, at), at), context);
			await host.commit(async (tx) => {
				for (const operation of started) await parts.start(tx, conversationId, operation, at);
			}, context);
			return committed;
		},
	}) };
}
