// Planted defect: a native sleep wakes immediately, releasing the reminder before its deadline.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { changeWorkers } from "./native-fixture.ts";

export function createEarlyDueRuntime(options: RuntimeOptions): Runtime {
	return changeWorkers(options, (task) => ({ definition: { ...task.definition, phases: {
		...task.definition.phases,
		run: (running, runtime, context) => task.definition.phases.run!(running, {
			...runtime, sleepUntil: (_deadline, checkpoint, callContext) => runtime.sleepUntil(runtime.now(), checkpoint, callContext),
		}, context),
	} } }));
}
