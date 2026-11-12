// Planted defect: the coordinator discards the terminal worker result after its native sleep.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { nativeFixture } from "./native-fixture.ts";

export function createLostDueRuntime(options: RuntimeOptions): Runtime {
	const { runtime, task } = nativeFixture(options);
	const broken: typeof task = { definition: { ...task.definition, phases: { ...task.definition.phases,
		settle: (_running, taskRuntime, context) => taskRuntime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
	} } };
	return { ...runtime, extension: { ...runtime.extension, tasks: [broken, ...(runtime.extension.tasks ?? []).slice(1)] } };
}
