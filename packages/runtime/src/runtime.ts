import type { Context } from "@earendil-works/chord";
import type { ConversationId, Extension, Harness } from "@earendil-works/pi-durable";
import { defineExtension } from "@earendil-works/pi-durable";
import type { Net, SelectionPolicy } from "@petrus/petri-net";
import { netProblems } from "@petrus/petri-net";
import { admit } from "./admit.ts";
import { createCoordination } from "./coordination.ts";
import type { Execution } from "./execution.ts";
import { createNetInstanceCache } from "./net-instance-cache.ts";
import { netInstanceRecord } from "./net-instance-record.ts";
import type { HandlerResult } from "./handlers.ts";
import { withHandlers } from "./handlers.ts";
import type { Committed } from "./net-instance-commit.ts";
import { checkedState, commitToNetInstance } from "./net-instance-commit.ts";
import type { Batch, NetInstanceState, StartBudget } from "./net-instance.ts";
import { viewOf } from "./net-instance-view.ts";
import type { Operation } from "./operations.ts";
import { admitResult, hostBatchProblems, operationsInFlight, startedOperation } from "./operations.ts";
import { pureExecution } from "./pure-execution.ts";
import type { Clock } from "./seams.ts";

/** Where net instances live: a Durable Harness, whose commits, committed reads and task aborts a net instance uses. */
export type NetInstanceHost = Pick<Harness, "commit" | "snapshot" | "abortTask">;

/** One net instance: the state of the net in one Durable conversation. */
export type NetInstance = {
	/**
	 * Admits tokens and reserves enabled bindings with their coordinators in one commit. Returns before execution.
	 * A repeated request returns its recorded ingress without allocating again. A new instance has no tokens.
	 */
	readonly enqueue: (batch: Batch, context: Context) => Promise<Committed>;
	/** The committed state. A conversation with no instance yet has no tokens and an empty log. */
	readonly state: (context: Context) => Promise<NetInstanceState>;
	/** The operations that the committed log started and has no result for, in log order. */
	readonly inFlight: (context: Context) => Promise<readonly Operation[]>;
	/** Durable start usage and pause state, separate from the marking and log. */
	readonly budget: (context: Context) => Promise<StartBudget>;
	/** Raises the absolute start ceiling. Repeated increases do not grant additional credit. */
	readonly raiseStartLimit: (ceiling: number, context: Context) => Promise<Committed>;
	/**
	 * Requests cancellation through the coordinator's ownership tree. A mark does not promise a domain-aborted result.
	 * Native task code chooses the result. Cancellation before launch creates no worker and leaves the inputs held.
	 */
	readonly abort: (operationId: string, context: Context) => Promise<"marked" | "terminal">;
	/**
	 * Records a supplied result only after the coordinator and its worker have ended. Preserves their outcomes.
	 * Validates every call, including duplicates. The first valid recorded result wins without restarting execution.
	 */
	readonly resolve: (operationId: string, result: HandlerResult, context: Context) => Promise<Committed>;
};

/** A net that runs on Pi Durable: the extension that the host installs, and the instances it opens. */
export type Runtime = {
	/** The expanded start/end net used by committed-log replay and inspection. */
	readonly net: Net;
	/** Registers coordinators and execution tasks. Install additional native child tasks in the same Harness registry. */
	readonly extension: Extension;
	/** The net instance in one conversation of a Harness that has the extension. */
	readonly instance: (host: NetInstanceHost, conversationId: ConversationId) => NetInstance;
};

/**
 * A runtime name, authored net, selection policy, shared Harness clock, native executions, and initial start ceiling.
 * Native task names must be unique in the Harness registry. Stored budgets override the initial ceiling on reopen.
 */
export type RuntimeOptions = {
	readonly name: string;
	/** Unique for this runtime object, including across process restarts. A host can use a random UUID. */
	readonly nonce: string;
	readonly net: Net;
	readonly policy: SelectionPolicy;
	readonly clock: Clock;
	readonly executions?: readonly Execution[];
	/** A finite, nonnegative integer ceiling for the instance's committed authored starts. */
	readonly startLimit: number;
};

/**
 * Expands every authored transition into a start and declared ends. Pure transitions use a minimal native task.
 * Internal ends settle before policy-selected starts. A refused whole step pauses starts without refusing settlement.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
	const { name, policy, clock, startLimit } = options;
	checkCeiling(startLimit);
	const executions = [
		...options.net.transitions.map((transition) => pureExecution(name, transition)),
		...(options.executions ?? []),
	];
	const net = withHandlers(
		{ places: options.net.places, transitions: [] },
		executions.map((registered) => registered.transition),
	);
	const problems = netProblems(net);
	if (problems.length > 0) {
		throw new Error(`invalid net: ${problems.join("; ")}`);
	}
	const handlerIds = new Set(executions.map((registered) => registered.transition.id));
	const { task, parts, taskOf, requireEnded } = createCoordination(
		{
			name,
			startLimit,
			cache: createNetInstanceCache(options.nonce),
			net,
			policy,
			handlerIds,
		},
		executions,
	);
	const initialBudget: StartBudget = { ceiling: startLimit, used: 0, paused: false };

	function instance(host: NetInstanceHost, conversationId: ConversationId): NetInstance {
		async function state(context: Context): Promise<NetInstanceState> {
			const stored = await host.snapshot(netInstanceRecord, conversationId, context);
			return stored === undefined ? { marking: {}, log: [] } : checkedState(parts, stored);
		}
		return {
			enqueue: (batch, context) => {
				const reserved = hostBatchProblems(handlerIds, batch);
				if (reserved.length > 0) {
					return Promise.reject(new Error(`invalid batch ${batch.requestId}: ${reserved.join("; ")}`));
				}
				// The time is read inside the commit, so the log's times never go back in log order.
				return host.commit((tx) => {
					const at = clock.now();
					return commitToNetInstance(tx, conversationId, parts, (current) => admit(net, current, batch, at), at);
				}, context);
			},
			state,
			inFlight: async (context) => operationsInFlight(handlerIds, (await state(context)).log),
			budget: async (context) => {
				const stored = await host.snapshot(netInstanceRecord, conversationId, context);
				if (stored === undefined) return initialBudget;
				checkedState(parts, stored);
				return stored.budget ?? initialBudget;
			},
			raiseStartLimit: (ceiling, context) =>
				host.commit(async (tx) => {
					checkCeiling(ceiling);
					const draft = await tx.doc(netInstanceRecord, conversationId);
					const current = checkedState(parts, draft);
					const budget = draft.budget ?? initialBudget;
					const requestId = `start-limit:${String(ceiling)}`;
					if (viewOf(current).ingressOf(requestId) === undefined && ceiling < budget.ceiling) {
						throw new RangeError("the start ceiling cannot decrease");
					}
					if (ceiling > budget.ceiling) {
						draft.budget = { ...budget, ceiling, paused: false };
					}
					const at = clock.now();
					return commitToNetInstance(
						tx,
						conversationId,
						parts,
						(view) => admit(net, view, { requestId, tokens: {} }, at),
						at,
					);
				}, context),
			resolve: (operationId, result, context) =>
				host.commit(async (tx) => {
					await requireEnded(tx, conversationId, operationId);
					const at = clock.now();
					return commitToNetInstance(
						tx,
						conversationId,
						parts,
						(view) => admitResult(net, handlerIds, view, operationId, result, at),
						at,
					);
				}, context),
			abort: async (operationId, context) => {
				const operation = startedOperation(handlerIds, viewOf(await state(context)), operationId);
				if (operation === undefined) {
					throw new Error(`no operation ${operationId} has started`);
				}
				const taskId = await host.commit((tx) => taskOf(tx, conversationId, operationId), context);
				return host.abortTask(taskId, context);
			},
		};
	}

	return {
		net,
		extension: defineExtension({
			name: `petrus.native-v1:${name}`,
			tasks: [task, ...executions.flatMap((registered) => registered.extension.tasks ?? [])],
		}),
		instance,
	};
}

function checkCeiling(ceiling: number): void {
	if (!Number.isSafeInteger(ceiling) || ceiling < 0) {
		throw new RangeError("the start ceiling must be a nonnegative safe integer");
	}
}
