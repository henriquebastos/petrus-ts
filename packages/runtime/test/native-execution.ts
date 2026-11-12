import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { defineTask } from "@earendil-works/pi-durable";
import type { NextTaskState, RunningTask, TaskRuntime } from "@earendil-works/pi-durable";
import type { Execution, ExecutionInput, HandlerResult, HandlerTransition } from "../src/index.ts";
import { execution } from "../src/index.ts";

export function completed(result: HandlerResult): NextTaskState<never, HandlerResult> {
	return { status: "terminal", outcome: { status: "completed", result } };
}

export async function completeSaved<S>(
	{ state }: RunningTask<ExecutionInput, { readonly phase: "due"; readonly result: HandlerResult }, HandlerResult>,
	runtime: TaskRuntime<ExecutionInput, S, HandlerResult, object>,
	context: Context,
): Promise<void> {
	await runtime.commit(() => completed(state.checkpoint.result), context);
}

export function immediateExecution(
	transition: HandlerTransition,
	run: (input: ExecutionInput, signal: AbortSignal) => Promise<HandlerResult>,
	aborted?: HandlerResult,
): Execution {
	return execution(
		transition,
		defineTask<ExecutionInput, { readonly phase: "run" }, HandlerResult>({
			name: `test:${randomUUID()}`,
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async ({ input }, runtime, context) => {
					const result = await run(input, runtime.signal);
					await runtime.commit(() => completed(result), context);
				},
			},
			abort: async (_task, runtime, context) => {
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: aborted === undefined ? { status: "aborted" } : { status: "completed", result: aborted },
					}),
					context,
				);
			},
		}),
	);
}
