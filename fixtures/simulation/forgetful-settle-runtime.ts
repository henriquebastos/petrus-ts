// Planted defect: settle runs only the operations that this process's steps started. It takes the operations in
// flight when it first looks as someone else's, so after a restart the work in flight at the crash never ends.
import type { Operation, Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime } from "../../packages/runtime/src/runtime.ts";
import { createSettle } from "../../packages/runtime/src/settle.ts";

export function createForgetfulSettleRuntime(options: RuntimeOptions): Runtime {
	const runtime = createRuntime(options);
	let before: ReadonlySet<string> | undefined;
	const inFlight = async (): Promise<readonly Operation[]> => {
		const operations = await runtime.inFlight();
		const known = before ?? new Set(operations.map((operation) => operation.id));
		before = known;
		return operations.filter((operation) => !known.has(operation.id));
	};
	return { ...runtime, settle: createSettle({ ...runtime, inFlight }, options.handlers ?? []) };
}
