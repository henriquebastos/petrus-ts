import type { Context } from "@earendil-works/chord";
import type { TaskRuntime } from "@earendil-works/pi-durable";
import type { HandlerResult } from "@petrus/runtime";

type OutcomeCommit<I, S> = Pick<TaskRuntime<I, S, HandlerResult, object>, "commit">;

export async function completeNative<I, S>(
	runtime: OutcomeCommit<I, S>,
	context: Context,
	result: HandlerResult,
): Promise<void> {
	await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
}

export async function abortNative<I, S>(_task: unknown, runtime: OutcomeCommit<I, S>, context: Context): Promise<void> {
	await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
}
