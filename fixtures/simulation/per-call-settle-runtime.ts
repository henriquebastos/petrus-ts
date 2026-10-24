// Planted defect: each settle keeps its own record of the runs it started, so two concurrent settles both start
// the same operation and its handler runs twice.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime } from "../../packages/runtime/src/runtime.ts";
import { createSettle } from "../../packages/runtime/src/settle.ts";

export function createPerCallSettleRuntime(options: RuntimeOptions): Runtime {
	const runtime = createRuntime(options);
	return { ...runtime, settle: () => createSettle(runtime, options.handlers ?? [])() };
}
