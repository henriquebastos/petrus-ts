// Planted defect: a native delay starts again at invocation, rather than allocation, after an outage.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { changeWorkers } from "./native-fixture.ts";

export function createFromRunRuntime(options: RuntimeOptions): Runtime {
	return changeWorkers(options, (task) => ({ definition: { ...task.definition, phases: {
		...task.definition.phases,
		run: (running, runtime, context) => task.definition.phases.run!({ ...running,
			input: { ...running.input, startedAt: runtime.now() } }, runtime, context),
	} } }));
}
