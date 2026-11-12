import type { Execution, ExecutionInput, HandlerResult, Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { createRuntime } from "../../packages/runtime/src/index.ts";
import { createCoordination } from "../../packages/runtime/src/coordination.ts";
import type { Coordination } from "../../packages/runtime/src/coordination.ts";
import { createNetInstanceCache } from "../../packages/runtime/src/net-instance-cache.ts";
import { pureExecution } from "../../packages/runtime/src/pure-execution.ts";

export function nativeFixture(options: RuntimeOptions): Coordination & { readonly runtime: Runtime } {
	const runtime = createRuntime(options);
	const executions = [...options.net.transitions.map((transition) => pureExecution(options.name, transition)), ...(options.executions ?? [])];
	const coordination = createCoordination({ name: options.name, startLimit: options.startLimit,
		cache: createNetInstanceCache(`${options.nonce}:fixture`), net: runtime.net, policy: options.policy,
		handlerIds: new Set(executions.map(({ transition }) => transition.id)) }, executions);
	return { runtime, ...coordination };
}

// These fixtures mutate the known native test tasks, not serialized input or a second execution engine.
declare const createTask: Parameters<Execution["launch"]>[0]["createTask"];
type Checkpoint = { readonly phase: string; readonly result?: HandlerResult };
export type Worker = Parameters<typeof createTask<ExecutionInput, Checkpoint, HandlerResult, object>>[0];

export function changeWorkers(options: RuntimeOptions, change: (task: Worker) => Worker): Runtime {
	const runtime = createRuntime(options);
	const names = new Set((options.executions ?? []).flatMap(({ extension }) => (extension.tasks ?? []).map(({ definition }) => definition.name)));
	return { ...runtime, extension: { ...runtime.extension, tasks: (runtime.extension.tasks ?? []).map((task) =>
		names.has(task.definition.name) ? change(task as Worker) : task) } };
}
