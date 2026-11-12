// Planted defect: an enqueue ignores the request ids that the log holds, so a host that sends a batch again after a
// crash, as it must when it cannot tell whether the batch landed, adds its tokens twice.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { nativeFixture } from "./native-fixture.ts";
import { admit } from "../../packages/runtime/src/admit.ts";
import { commitToNetInstance } from "../../packages/runtime/src/net-instance-commit.ts";

export function createIdBlindRuntime(options: RuntimeOptions): Runtime {
	const { runtime, parts } = nativeFixture(options);
	return {
		net: runtime.net,
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
							(current) => admit(runtime.net, { ...current, ingressOf: () => undefined }, batch, at),
							at,
						),
					context,
				);
			},
		}),
	};
}
