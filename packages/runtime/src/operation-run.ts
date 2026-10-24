import type { Context, JsonValue } from "@earendil-works/chord";
import type { Task, TaskRuntime } from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import { transitionId } from "@petrus/petri-net";
import { json } from "./net-instance-record.ts";
import type { DelayedResult, Handler, HandlerResult } from "./handlers.ts";
import type { NetInstanceParts, StartOperation } from "./net-instance-commit.ts";
import { commitToNetInstance } from "./net-instance-commit.ts";
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
 * How the operations of one net run: the Durable task kind that runs them, and the parts of the net's commits, whose
 * `start` creates a task of that kind.
 */
export type OperationRun = {
	readonly task: Task<OperationInput, Checkpoint, StoredResult, object>;
	readonly parts: NetInstanceParts;
};

/**
 * The task kind `petrus.operation:<net>`. A task runs one operation. Its `run` phase calls the handler with the
 * operation's binding and id. For a result, one commit ends the task with it, puts it on the result place, and steps
 * the net until it is quiet. For a delayed result, the task sleeps until the operation's start time plus the delay,
 * and its `due` phase makes that same commit. A throw in a phase is reported to the host; the task sleeps for
 * `retryDelayMs` and runs the phase again, as the operation is still in flight. After a crash Durable runs the phase
 * again, so a handler runs at least once and its result counts once.
 */
export function createOperationRun(parts: OperationRunParts): OperationRun {
	const start: StartOperation = (tx, conversationId, operation, startedAt) =>
		tx.createTask(task, inputOf(operation, startedAt), { ownership: { kind: "conversation" }, conversationId });
	const netInstanceParts: NetInstanceParts = { ...parts, start };
	const handlers = new Map(parts.handlers.map((handler) => [handler.transition.id, handler]));

	async function run(input: Readonly<OperationInput>, taskRuntime: RunningTask, context: Context): Promise<void> {
		const operation = operationOf(input);
		await retried(taskRuntime, { phase: "run" }, context, async () => {
			const answer = await handlerOf(operation).run(operation.binding, { operationId: operation.id });
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
				(state) => admitResult(parts.net, parts.handlerIds, state, operation.id, result, at),
				at,
			);
			return { status: "terminal", outcome: { status: "completed", result: storedResult(result) } };
		}, context);
	}

	/** Runs a phase's work. A throw is reported, and the task sleeps `retryDelayMs` before the phase runs again. */
	async function retried(
		taskRuntime: RunningTask,
		checkpoint: Checkpoint,
		context: Context,
		work: () => Promise<void>,
	): Promise<void> {
		try {
			await work();
		} catch (error: unknown) {
			// An abort or a close stops the task: Durable ends it, so the failed commit is no failure to report.
			if (taskRuntime.signal.aborted) {
				throw error;
			}
			taskRuntime.report(error);
			await taskRuntime.sleepUntil(taskRuntime.now() + parts.retryDelayMs, checkpoint, context);
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
		phases: {
			run: (running, taskRuntime, context) => run(running.input, taskRuntime, context),
			due: (running, taskRuntime, context) => due(running.input, running.state.checkpoint, taskRuntime, context),
		},
		abort: (_running, taskRuntime, context) =>
			taskRuntime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
	return { task, parts: netInstanceParts };
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
