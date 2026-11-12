import { defineTask } from "@earendil-works/pi-durable";
import type { Transition } from "@petrus/petri-net";
import type { Execution, ExecutionInput } from "./execution.ts";
import { execution } from "./execution.ts";
import type { HandlerResult } from "./handlers.ts";

/** Pure authored work uses the same owned-task lifecycle as external work. Its arcs run during settlement. */
export function pureExecution(name: string, transition: Transition): Execution {
	const { outputs, ...start } = transition;
	const task = defineTask<ExecutionInput, { readonly phase: "complete" }, HandlerResult>({
		name: `petrus.pure.native-v1:${name}:${transition.id}`,
		version: 1,
		initial: () => ({ phase: "complete" }),
		phases: {
			complete: (_running, runtime, context) =>
				runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "completed", result: { variant: "done", value: null } },
					}),
					context,
				),
		},
		abort: (_running, runtime, context) =>
			runtime.commit(
				() => ({
					status: "terminal",
					outcome: { status: "aborted" },
				}),
				context,
			),
	});
	return execution(
		{
			...start,
			// Stryker disable next-line StringLiteral: This private colour label is not exposed; result validation uses contains.
			variants: { done: { value: { name: "UNIT", contains: (value) => value === null }, outputs } },
		},
		task,
	);
}
