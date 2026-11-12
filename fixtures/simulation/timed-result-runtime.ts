// Planted defect: settlement records a terminal result under a time-based id rather than result:<operation>.
import type { Runtime, RuntimeOptions } from "../../packages/runtime/src/index.ts";
import { resultPlaceId } from "../../packages/runtime/src/index.ts";
import { admit } from "../../packages/runtime/src/admit.ts";
import { commitToNetInstance } from "../../packages/runtime/src/net-instance-commit.ts";
import { nativeFixture } from "./native-fixture.ts";

export function createTimedResultRuntime(options: RuntimeOptions): Runtime {
	const { runtime, task, parts } = nativeFixture(options);
	const broken: typeof task = { definition: { ...task.definition, phases: { ...task.definition.phases,
		settle: (running, taskRuntime, context) => taskRuntime.commit(async (tx) => {
			const worker = await tx.task(running.state.checkpoint.worker);
			if (worker?.state.status === "terminal" && "result" in worker.state.outcome) {
				const result = worker.state.outcome.result;
				if (typeof result !== "object" || result === null || Array.isArray(result)) throw new Error("expected a result envelope");
				const at = taskRuntime.now();
				const tokens = { [resultPlaceId(running.input.transition)]: [{ binding: running.input.binding, ...result }] };
				await commitToNetInstance(tx, taskRuntime.conversationId, parts,
					(view) => admit(runtime.net, view, { requestId: `${running.input.id}@${String(at)}`, tokens }, at), at);
			}
			return { status: "terminal", outcome: { status: "completed", result: null } };
		}, context),
	} } };
	return { ...runtime, extension: { ...runtime.extension, tasks: [broken, ...(runtime.extension.tasks ?? []).slice(1)] } };
}
