// Planted defect: coordinator settlement retries a broken stored instance forever.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { nativeFixture } from "./native-fixture.ts";

export function createRetryEveryThrowRuntime(options: RuntimeOptions): Runtime {
	const { runtime, task } = nativeFixture(options);
	const broken: typeof task = { definition: { ...task.definition, phases: { ...task.definition.phases,
		settle: async (running, taskRuntime, context) => {
			try { await task.definition.phases.settle(running, taskRuntime, context); }
			catch (error) {
				taskRuntime.report(error);
				await taskRuntime.sleepUntil(taskRuntime.now() + 10, running.state.checkpoint, context);
			}
		},
	} } };
	return { ...runtime, extension: { ...runtime.extension, tasks: [broken, ...(runtime.extension.tasks ?? []).slice(1)] } };
}
