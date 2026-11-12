import type { Extension, Task, TaskId, Tx } from "@earendil-works/pi-durable";
import { defineExtension } from "@earendil-works/pi-durable";
import type { Binding, TransitionId } from "@petrus/petri-net";
import type { HandlerResult, HandlerTransition } from "./handlers.ts";

/** The serializable operation that a native task runs. */
export type ExecutionInput = {
	readonly id: string;
	readonly transition: TransitionId;
	readonly binding: Binding;
	readonly startedAt: number;
};

/** Registers and launches a transition's native task without exposing its checkpoints or hooks. */
export type Execution = {
	readonly transition: HandlerTransition;
	readonly extension: Extension;
	readonly launch: (tx: Tx, input: ExecutionInput, owner: TaskId) => Promise<TaskId<HandlerResult>>;
};

/** Keeps the supplied task's phases, retries, results, and abort behavior under that task's control. */
export function execution<S extends { readonly phase: string }, H extends object>(
	transition: HandlerTransition,
	task: Task<ExecutionInput, S, HandlerResult, H>,
): Execution {
	return {
		transition,
		extension: defineExtension({ name: `petrus.execution:${task.definition.name}`, tasks: [task] }),
		launch: (tx, input, owner) => tx.createTask(task, input, { ownership: { kind: "task", taskId: owner } }),
	};
}
