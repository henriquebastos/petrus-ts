import type { Context, JsonValue } from "@earendil-works/chord";
import type { ConversationId, Task, TaskRuntime, Tx } from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import { transitionId } from "@petrus/petri-net";
import { json } from "./net-instance-record.ts";
import type { Handler, HandlerResult } from "./handlers.ts";
import type { NetInstanceParts, StartOperation } from "./net-instance-commit.ts";
import { commitToNetInstance } from "./net-instance-commit.ts";
import type { Operation } from "./operations.ts";
import { admitResult } from "./operations.ts";

type OperationInput = { id: string; transition: string; binding: Record<string, JsonValue> };
type Checkpoint = { phase: "run" };
type StoredResult = { variant: string; value: JsonValue };
type RunningTask = TaskRuntime<OperationInput, Checkpoint, StoredResult, object>;

/** What the operation runs of a net need: the parts of its commits, the handlers, and how long a failed run waits. */
export type OperationRunParts = Omit<NetInstanceParts, "start"> & {
	readonly handlers: readonly Handler[];
	readonly retryDelayMs: number;
};

/**
 * How the operations of one net run: the Durable task kind that runs them, and the parts of the net's commits, whose
 * `start` creates a task of that kind.
 */
export type OperationRun = {
	readonly task: Task<OperationInput, Checkpoint, StoredResult, object>;
	readonly parts: NetInstanceParts;
};

/**
 * The task kind `petrus.operation:<net>`. A task runs one operation: its `run` phase calls the handler with the
 * operation's binding and id, then one commit ends the task with the result, puts the result on the result place,
 * and steps the net until it is quiet. A handler that throws, or a result whose commit throws, is reported to the
 * host; the task sleeps for `retryDelayMs` and runs the handler again, as the operation is still in flight. After a
 * crash Durable runs the phase again, so a handler runs at least once and its result counts once.
 */
export function createOperationRun(parts: OperationRunParts): OperationRun {
	const start: StartOperation = (tx: Tx, conversationId: ConversationId, operation: Operation) =>
		tx.createTask(task, inputOf(operation), { ownership: { kind: "conversation" }, conversationId });
	const netInstanceParts: NetInstanceParts = { ...parts, start };
	const handlers = new Map(parts.handlers.map((handler) => [handler.transition.id, handler]));

	async function run(operation: Operation, taskRuntime: RunningTask, context: Context): Promise<void> {
		try {
			const result = await handlerOf(operation).run(operation.binding, { operationId: operation.id });
			await taskRuntime.commit(async (tx) => {
				const at = taskRuntime.now();
				await commitToNetInstance(
					tx,
					taskRuntime.conversationId,
					netInstanceParts,
					(state) => admitResult(parts.net, parts.handlerIds, state, operation.id, result, at),
					at,
				);
				return { status: "terminal", outcome: { status: "completed", result: storedResult(result) } };
			}, context);
		} catch (error: unknown) {
			// An abort or a close stops the task: Durable ends it, so the failed commit is no failure to report.
			if (taskRuntime.signal.aborted) {
				throw error;
			}
			taskRuntime.report(error);
			await taskRuntime.sleepUntil(taskRuntime.now() + parts.retryDelayMs, { phase: "run" }, context);
		}
	}

	function handlerOf(operation: Operation): Handler {
		const handler = handlers.get(operation.transition);
		if (handler === undefined) {
			throw new Error(`no handler runs ${operation.transition}`);
		}
		return handler;
	}

	const task = defineTask<OperationInput, Checkpoint, StoredResult>({
		name: `petrus.operation:${parts.name}`,
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: { run: (running, taskRuntime, context) => run(operationOf(running.input), taskRuntime, context) },
		abort: (_running, taskRuntime, context) =>
			taskRuntime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
	return { task, parts: netInstanceParts };
}

function inputOf(operation: Operation): OperationInput {
	return {
		id: operation.id,
		transition: operation.transition,
		binding: Object.fromEntries(Object.entries(operation.binding).map(([key, value]) => [key, json(value)])),
	};
}

function operationOf(input: Readonly<OperationInput>): Operation {
	return { id: input.id, transition: transitionId(input.transition), binding: input.binding };
}

function storedResult(result: HandlerResult): StoredResult {
	return { variant: result.variant, value: json(result.value) };
}
