// Planted defect: discard the authored task's explicit outage retry. Uncaught errors should fault normally.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { changeWorkers } from "./native-fixture.ts";

export function createUncaughtThrowRuntime(options: RuntimeOptions): Runtime {
	return changeWorkers(options, (task) => ({ definition: { ...task.definition, phases: {
		...task.definition.phases,
		run: (running, runtime, context) => task.definition.phases.run!(running, {
			...runtime, sleepUntil: () => Promise.reject(new Error("the authored outage retry was dropped")),
		}, context),
	} } }));
}
