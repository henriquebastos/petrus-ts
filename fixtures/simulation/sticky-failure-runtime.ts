// Planted defect: a run whose handler threw stays marked as started, so this runtime never runs that operation
// again and the work stays in flight until the process restarts.
import type { Handler, Operation, Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime } from "../../packages/runtime/src/runtime.ts";
import { createSettle } from "../../packages/runtime/src/settle.ts";

export function createStickyFailureRuntime(options: RuntimeOptions): Runtime {
	const failed = new Set<string>();
	const handlers = (options.handlers ?? []).map(
		(handler): Handler => ({
			...handler,
			run: (binding, context) =>
				handler.run(binding, context).catch((error: unknown) => {
					failed.add(context.operationId);
					throw error;
				}),
		}),
	);
	const runtime = createRuntime({ ...options, handlers });
	const inFlight = async (): Promise<readonly Operation[]> =>
		(await runtime.inFlight()).filter((operation) => !failed.has(operation.id));
	return { ...runtime, inFlight, settle: createSettle({ ...runtime, inFlight }, handlers) };
}
