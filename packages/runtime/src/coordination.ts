import type { JsonValue } from "@earendil-works/chord";
import type {
	ConversationDocFamilyToken,
	ConversationId,
	Cursor,
	Task,
	TaskId,
	TaskRecord,
	Tx,
} from "@earendil-works/pi-durable";
import { defineDocFamily, defineTask } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Token } from "@petrus/petri-net";
import { tokenKey } from "@petrus/petri-net";
import type { Execution, ExecutionInput } from "./execution.ts";
import type { HandlerResult } from "./handlers.ts";
import type { NetInstanceParts, StartOperation } from "./net-instance-commit.ts";
import { commitToNetInstance } from "./net-instance-commit.ts";
import { admitResult } from "./operations.ts";

type Checkpoint = { readonly phase: "launch" } | { readonly phase: "settle"; readonly worker: TaskId };
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type LaunchReceipt = { initialized: boolean; worker: TaskId | null };

// Terminal task records discard checkpoints. This receipt distinguishes no launch from a missing worker record.
const launchReceipt: ConversationDocFamilyToken<LaunchReceipt, null> = defineDocFamily<LaunchReceipt, null>({
	kind: "petrus.native-launch",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	family: true,
	initial: () => ({ initialized: false, worker: null }),
	checkpointWhen: () => false,
});

const resultShape = Type.Object({ variant: Type.String(), value: Type.Unknown() }, { additionalProperties: false });

/** The native coordinator and the transaction checks used by host recovery. */
export type Coordination = {
	readonly task: Task<ExecutionInput, Checkpoint, null, object>;
	readonly parts: NetInstanceParts;
	readonly taskOf: (tx: Tx, conversationId: ConversationId, operationId: string) => Promise<TaskId>;
	readonly requireEnded: (tx: Tx, conversationId: ConversationId, operationId: string) => Promise<void>;
};

/** Reserves tokens with a coordinator, launches one owned task, and settles only its terminal result. */
export function createCoordination(
	parts: Omit<NetInstanceParts, "start">,
	executions: readonly Execution[],
): Coordination {
	const byTransition = new Map(executions.map((registered) => [registered.transition.id, registered]));
	const start: StartOperation = async (tx, conversationId, operation, startedAt) => {
		const id = await tx.createTask(
			task,
			{ ...operation, startedAt },
			{
				ownership: { kind: "conversation" },
				conversationId,
			},
		);
		(await tx.doc(launchReceipt, conversationId, String(id), null)).initialized = true;
		return id;
	};
	const commits: NetInstanceParts = { ...parts, start };

	async function settle(
		tx: Tx,
		owner: TaskId,
		input: ExecutionInput,
		conversationId: ConversationId,
		at: number,
	): Promise<void> {
		const worker = await workerOf(tx, owner, conversationId, input);
		if (worker === undefined) {
			return;
		}
		if (worker.state.status !== "terminal") {
			throw new Error(`execution of ${input.id} has not ended`);
		}
		const outcome = worker.state.outcome;
		if ("result" in outcome) {
			const result = checkedResult(outcome.result);
			await commitToNetInstance(
				tx,
				conversationId,
				commits,
				(view) => admitResult(parts.net, parts.handlerIds, view, input.id, result, at),
				at,
			);
		}
	}

	const task = defineTask<ExecutionInput, Checkpoint, null>({
		name: `petrus.coordinator.native-v1:${parts.name}`,
		version: 1,
		initial: () => ({ phase: "launch" }),
		phases: {
			launch: (running, runtime, context) =>
				runtime.commit(async (tx) => {
					const registered = byTransition.get(running.input.transition);
					if (registered === undefined) {
						throw new Error(`no execution runs ${running.input.transition}`);
					}
					const receipt = await tx.doc(launchReceipt, runtime.conversationId, String(running.id), null);
					if (!receipt.initialized || receipt.worker !== null) {
						throw new Error(`inconsistent launch for ${running.input.id}`);
					}
					const worker = await registered.launch(tx, running.input, running.id);
					receipt.worker = worker;
					return {
						status: "waiting",
						on: [worker],
						policy: "allSettled",
						checkpoint: { phase: "settle", worker },
					};
				}, context),
			settle: (running, runtime, context) =>
				runtime.commit(async (tx) => {
					const receipt = await tx.doc(launchReceipt, runtime.conversationId, String(running.id), null);
					if (receipt.worker !== running.state.checkpoint.worker) {
						throw new Error(`inconsistent execution for ${running.input.id}`);
					}
					await settle(tx, running.id, running.input, runtime.conversationId, runtime.now());
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, context),
		},
		abort: (running, runtime, context) =>
			runtime.commit(async (tx) => {
				await settle(tx, running.id, running.input, runtime.conversationId, runtime.now());
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context),
	});

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
		throw new Error(`no coordinator runs the operation ${operationId}`);
	}

	async function requireEnded(tx: Tx, conversationId: ConversationId, operationId: string): Promise<void> {
		const id = await taskOf(tx, conversationId, operationId);
		const coordinator = await tx.task(id);
		if (coordinator?.state.status !== "terminal") {
			throw new Error(`the coordinator of operation ${operationId} has not ended`);
		}
		const worker = await workerOf(tx, id, conversationId, coordinator.input);
		if (worker !== undefined && worker.state.status !== "terminal") {
			throw new Error(`the execution of operation ${operationId} has not ended`);
		}
	}

	return { task, parts: commits, taskOf, requireEnded };
}

async function workerOf(
	tx: Tx,
	owner: TaskId,
	conversationId: ConversationId,
	input: Token,
): Promise<StoredTask | undefined> {
	const receipt = await tx.doc(launchReceipt, conversationId, String(owner), null);
	if (!receipt.initialized) {
		throw new Error("missing native launch receipt");
	}
	if (receipt.worker === null) {
		return undefined;
	}
	const worker = await tx.task(receipt.worker);
	if (worker === undefined || !belongsTo(worker, owner, conversationId, input)) {
		throw new Error("missing or inconsistent native execution record");
	}
	return worker;
}

function isInputOf(input: JsonValue, operationId: string): boolean {
	return isObject(input) && input.id === operationId;
}

function belongsTo(worker: StoredTask, owner: TaskId, conversationId: ConversationId, input: Token): boolean {
	return (
		worker.owner === owner && worker.conversationId === conversationId && tokenKey(worker.input) === tokenKey(input)
	);
}

function isObject(value: JsonValue): value is Record<string, JsonValue> {
	// Stryker disable next-line ConditionalExpression: JSON primitives have no operation id and the result schema rejects them; this check narrows their type.
	const object = typeof value === "object";
	return object && value !== null && !Array.isArray(value);
}

function checkedResult(value: JsonValue): HandlerResult {
	if (!isObject(value)) {
		throw new TypeError("native execution returned an invalid result envelope");
	}
	const { variant, value: result } = value;
	if (!Value.Check(resultShape, value) || typeof variant !== "string" || result === undefined) {
		throw new TypeError("native execution returned an invalid result envelope");
	}
	return { variant, value: result };
}
