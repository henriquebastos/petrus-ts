// Planted defect: the runtime ignores a handler's delay and records the result at once, so a timer runs out at its
// start and a reminder comes before its time.
import type { Handler, Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime } from "../../packages/runtime/src/index.ts";

export function createEarlyDueRuntime(options: RuntimeOptions): Runtime {
	const handlers = (options.handlers ?? []).map(
		(handler): Handler => ({
			transition: handler.transition,
			run: async (binding, context) => {
				const answer = await handler.run(binding, context);
				return "delayMs" in answer ? answer.result : answer;
			},
		}),
	);
	return createRuntime({ ...options, handlers });
}
