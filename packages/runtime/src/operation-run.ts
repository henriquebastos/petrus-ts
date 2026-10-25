import type { Context, JsonValue } from "@earendil-works/chord";
import type { ConversationId, Cursor, Task, TaskId, TaskRuntime, Tx } from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import type { TransitionId } from "@petrus/petri-net";
import { transitionId } from "@petrus/petri-net";
import { json } from "./net-instance-record.ts";
import type { DelayedResult, Handler, HandlerResult } from "./handlers.ts";
import { abortedVariant, declaresAborted } from "./handlers.ts";
import type { NetInstanceParts, StartOperation } from "./net-instance-commit.ts";
import { commitToNetInstance } from "./net-instance-commit.ts";
import { BrokenNetInstance } from "./net-instance.ts";
import type { Operation } from "./operations.ts";
import { admitResult, checkedResultBatch } from "./operations.ts";

type OperationInput = { id: string; transition: string; binding: Record<string, JsonValue>; startedAt: number };
type StoredResult = { variant: string; value: JsonValue };
type Checkpoint = { phase: "run" } | { phase: "due"; result: StoredResult };
type RunningTask = TaskRuntime<OperationInput, Checkpoint, StoredResult, object>;

/** What the operation runs of a net need: the parts of its commits, the handlers, and how long a failed run waits. */
export type OperationRunParts = Omit<NetInstanceParts, "start"> & {
	readonly handlers: readonly Handler[];
	readonly retryDelayMs: number;
};

/**
 * How the operations of one net run: the Durable task kind that runs them, the parts of the net's commits, whose
 * `start` creates a task of that kind, and how to find the task of an operation.
 */
export type OperationRun = {
	readonly task: Task<OperationInput, Checkpoint, StoredResult, object>;
	readonly parts: NetInstanceParts;
	readonly taskOf: (tx: Tx, conversationId: ConversationId, operationId: string) => Promise<TaskId>;
	/** True when the transition's handler declares the variant `aborted`, so its operations can be aborted. */
	readonly abortable: (transition: TransitionId) => boolean;
};

/**
 * The task kind `petrus.operation:<net>`. A task runs one operation. Its `run` phase calls the handler with the
 * operation's binding and id. For a result, one commit ends the task with it, puts it on the result place, and steps
 * the net until it is quiet. For a delayed result, the task sleeps until the operation's start time plus the delay,
 * and its `due` phase makes that same commit. A throw in a phase is reported to the host; the task sleeps for
 * `retryDelayMs` and runs the phase again, as the operation is still in flight. A `BrokenNetInstance` from the
 * result's commit would throw again, so it ends the task as faulted. After a crash Durable runs the phase
 * again, so a handler runs at least once and its result counts once. An aborted task whose transition declares the
 * variant `aborted` records that result and steps, in the commit that ends the task.
 */
export function createOperationRun(parts: OperationRunParts): OperationRun {
	const start: StartOperation = (tx, conversationId, operation, startedAt) =>
		tx.createTask(task, inputOf(operation, startedAt), { ownership: { kind: "conversation" }, conversationId });
	const netInstanceParts: NetInstanceParts = { ...parts, start };
	const handlers = new Map(parts.handlers.map((handler) => [handler.transition.id, handler]));

	async function run(input: Readonly<OperationInput>, taskRuntime: RunningTask, context: Context): Promise<void> {
		const operation = operationOf(input);
		await retried(taskRuntime, { phase: "run" }, context, async () => {
			const answer = await handlerOf(operation).run(operation.binding, {
				operationId: operation.id,
				signal: taskRuntime.signal,
			});
			if (!isDelayed(answer)) {
				await complete(operation, answer, taskRuntime, context);
				return;
			}
			const until = input.startedAt + checkedDelay(answer.delayMs);
			checkedResultBatch(parts.net, operation, answer.result);
			await taskRuntime.sleepUntil(until, { phase: "due", result: storedResult(answer.result) }, context);
		});
	}

	async function due(
		input: Readonly<OperationInput>,
		checkpoint: Readonly<Checkpoint & { phase: "due" }>,
		taskRuntime: RunningTask,
		context: Context,
	): Promise<void> {
		await retried(taskRuntime, checkpoint, context, () =>
			complete(operationOf(input), checkpoint.result, taskRuntime, context),
		);
	}

	/** The commit that ends the task with `result`, puts it on the result place, and steps until quiet. */
	async function complete(
		operation: Operation,
		result: HandlerResult,
		taskRuntime: RunningTask,
		context: Context,
	): Promise<void> {
		await taskRuntime.commit(async (tx) => {
			const at = taskRuntime.now();
			await commitToNetInstance(
				tx,
				taskRuntime.conversationId,
				netInstanceParts,
				(view) => admitResult(parts.net, parts.handlerIds, view, operation.id, result, at),
				at,
			);
			return { status: "terminal", outcome: { status: "completed", result: storedResult(result) } };
		}, context);
	}

	/**
	 * Runs a phase's work. A throw is reported, and the task sleeps `retryDelayMs` before the phase runs again. A
	 * `BrokenNetInstance` would throw again on each run, so it ends the task as faulted, and Durable reports it once.
	 */
	async function retried(
		taskRuntime: RunningTask,
		checkpoint: Checkpoint,
		context: Context,
		work: () => Promise<void>,
	): Promise<void> {
		try {
			await work();
		} catch (error: unknown) {
			// An abort or a close stops the task: Durable ends it, so the failed commit is no failure to report. A broken
			// net instance would throw again: Durable ends the task faulted, and reports it once.
			if (taskRuntime.signal.aborted || error instanceof BrokenNetInstance) {
				throw error;
			}
			taskRuntime.report(error);
			await taskRuntime.sleepUntil(taskRuntime.now() + parts.retryDelayMs, checkpoint, context);
		}
	}

	/**
	 * The commit that ends an aborted task. When the transition declares `aborted`, it records that result and steps
	 * until quiet, so the net can give the tokens back. A throw here ends the task as faulted.
	 */
	async function aborted(operation: Operation, taskRuntime: RunningTask, context: Context): Promise<void> {
		await taskRuntime.commit(async (tx) => {
			if (abortable(operation.transition)) {
				const at = taskRuntime.now();
				const result = { variant: abortedVariant, value: null };
				await commitToNetInstance(
					tx,
					taskRuntime.conversationId,
					netInstanceParts,
					(view) => admitResult(parts.net, parts.handlerIds, view, operation.id, result, at),
					at,
				);
			}
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	}

	/**
	 * The task of the operation `operationId` in the conversation, from Durable's task records, which it keeps after
	 * the task ends. A started operation with no task is a bug, so it throws.
	 */
	async function taskOf(tx: Tx, conversationId: ConversationId, operationId: string): Promise<TaskId> {
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanTasks({ conversationId, kind: task.definition.name }, 100, cursor);
			const found = page.items.find((record) => isInputOf(record.input, operationId));
			if (found !== undefined) {
				return found.id;
			}
			cursor = page.next;
		} while (cursor !== undefined);
		throw new Error(`no task runs the operation ${operationId}`);
	}

	function abortable(transition: TransitionId): boolean {
		const handler = handlers.get(transition);
		return handler !== undefined && declaresAborted(handler.transition);
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
		phases: {
			run: (running, taskRuntime, context) => run(running.input, taskRuntime, context),
			due: (running, taskRuntime, context) => due(running.input, running.state.checkpoint, taskRuntime, context),
		},
		abort: (running, taskRuntime, context) => aborted(operationOf(running.input), taskRuntime, context),
	});
	return { task, parts: netInstanceParts, taskOf, abortable };
}

/** True when a stored task input is that of the operation `operationId`. */
function isInputOf(input: JsonValue, operationId: string): boolean {
	return typeof input === "object" && input !== null && !Array.isArray(input) && input.id === operationId;
}

function isDelayed(answer: HandlerResult | DelayedResult): answer is DelayedResult {
	return "delayMs" in answer;
}

/** A delay is a finite number of milliseconds, at least 0. Any other is a bug in the handler, so it throws. */
function checkedDelay(delayMs: number): number {
	if (!Number.isFinite(delayMs) || delayMs < 0) {
		throw new RangeError(`a delay must be a finite number of milliseconds, at least 0, not ${String(delayMs)}`);
	}
	return delayMs;
}

function inputOf(operation: Operation, startedAt: number): OperationInput {
	return {
		startedAt,
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
