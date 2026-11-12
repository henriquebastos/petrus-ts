// Planted defect: abort admits the sleeping checkpoint's result instead of the authored abort result.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { admitResult } from "../../packages/runtime/src/operations.ts";
import { commitToNetInstance } from "../../packages/runtime/src/net-instance-commit.ts";
import { changeWorkers, nativeFixture } from "./native-fixture.ts";

export function createDueOnAbortRuntime(options: RuntimeOptions): Runtime {
	const { runtime, parts } = nativeFixture(options);
	return changeWorkers(options, (task) => ({ definition: { ...task.definition,
		abort: (running, taskRuntime, context) => {
			const result = running.state.checkpoint.result;
			if (running.state.checkpoint.phase !== "due" || result === undefined) return task.definition.abort(running, taskRuntime, context);
			return task.definition.abort(running, { ...taskRuntime,
				commit: (change, callContext) => taskRuntime.commit(async (tx, hooks) => {
					const state = await change(tx, hooks);
					const at = taskRuntime.now();
					await commitToNetInstance(tx, taskRuntime.conversationId, parts,
						(view) => admitResult(runtime.net, parts.handlerIds, view, running.input.id, result, at), at);
					return state;
				}, callContext),
			}, context);
		},
	} }));
}
