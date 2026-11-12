// Planted defect: coordinator abort drops the worker's authored abort result.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { nativeFixture } from "./native-fixture.ts";

export function createLostAbortRuntime(options: RuntimeOptions): Runtime {
	const { runtime, task } = nativeFixture(options);
	const broken: typeof task = { definition: { ...task.definition,
		abort: (_running, taskRuntime, context) => taskRuntime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	} };
	return { ...runtime, extension: { ...runtime.extension, tasks: [broken, ...(runtime.extension.tasks ?? []).slice(1)] } };
}
