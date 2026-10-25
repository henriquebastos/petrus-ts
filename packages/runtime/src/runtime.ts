import type { Context } from "@earendil-works/chord";
import type { ConversationId, Extension, Harness } from "@earendil-works/pi-durable";
import { defineExtension } from "@earendil-works/pi-durable";
import type { Net, SelectionPolicy } from "@petrus/petri-net";
import { netProblems } from "@petrus/petri-net";
import { admit } from "./admit.ts";
import { netInstanceRecord } from "./net-instance-record.ts";
import { createOperationRun } from "./operation-run.ts";
import type { Handler } from "./handlers.ts";
import { handlerProblems, withHandlers } from "./handlers.ts";
import type { Committed } from "./net-instance-commit.ts";
import { checkedState, commitToNetInstance } from "./net-instance-commit.ts";
import type { Batch, NetInstanceState } from "./net-instance.ts";
import type { Operation } from "./operations.ts";
import { hostBatchProblems, operationsInFlight, startedOperations } from "./operations.ts";
import type { Clock } from "./seams.ts";

/** Where net instances live: a Durable Harness, whose commits, committed reads and task aborts a net instance uses. */
export type NetInstanceHost = Pick<Harness, "commit" | "snapshot" | "abortTask">;

/** One net instance: the state of the net in one Durable conversation. */
export type NetInstance = {
	/**
	 * Adds a batch of tokens from outside and steps the net until it is quiet, in one commit with the batch's
	 * ingress, the firings and the start of the work they begin. A batch whose request id the log already holds adds
	 * nothing and returns the recorded ingress, so a retry after a lost reply is safe. The first batch of an instance
	 * gives it its first tokens: a new instance has none.
	 */
	readonly enqueue: (batch: Batch, context: Context) => Promise<Committed>;
	/** The committed state. A conversation with no instance yet has no tokens and an empty log. */
	readonly state: (context: Context) => Promise<NetInstanceState>;
	/** The operations that the committed log started and has no result for, in log order. */
	readonly inFlight: (context: Context) => Promise<readonly Operation[]>;
	/**
	 * Aborts an operation. Its task stops the handler (see `HandlerContext.signal`), then one commit records the
	 * result `aborted`, steps the net until it is quiet, and ends the task. `marked` when the abort was recorded,
	 * `terminal` when the task had already ended: as a rule its operation has a result, but a faulted task leaves its
	 * operation in flight. An operation that has not started, or whose transition declares
	 * no variant `aborted`, is a bug in the host, so it throws.
	 */
	readonly abort: (operationId: string, context: Context) => Promise<"marked" | "terminal">;
};

/** A net that runs on Pi Durable: the extension that the host installs, and the instances it opens. */
export type Runtime = {
	/** Holds the task kind that runs the operations. Install it in the Harness's registry before `Harness.open`. */
	readonly extension: Extension;
	/** The net instance in one conversation of a Harness that has the extension. */
	readonly instance: (host: NetInstanceHost, conversationId: ConversationId) => NetInstance;
};

/**
 * What a runtime needs: a name that is unique in the Harness, the net, the policy that orders and filters the
 * enabled binding elements, the clock that stamps the log, the handler transitions with their handlers, and how long
 * a failed handler run waits before it runs again. Give the Harness the same clock as `now`: the handler tasks
 * stamp their commits with it.
 */
export type RuntimeOptions = {
	readonly name: string;
	readonly net: Net;
	readonly policy: SelectionPolicy;
	readonly clock: Clock;
	readonly handlers?: readonly Handler[];
	readonly retryDelayMs: number;
};

/**
 * Builds the runtime of one net. It runs the plain net that `withHandlers` makes from the net and the handler
 * transitions. A net with problems (see `netProblems`) is a bug, so it throws. Every commit steps the net until the
 * policy selects nothing, and each operation that a commit starts runs in a Durable task created in that commit.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
	const { name, policy, clock, handlers = [], retryDelayMs } = options;
	const net = withHandlers(
		options.net,
		handlers.map((handler) => handler.transition),
	);
	const problems = [...netProblems(net), ...handlerProblems(handlers.map((handler) => handler.transition))];
	if (problems.length > 0) {
		throw new Error(`invalid net: ${problems.join("; ")}`);
	}
	const handlerIds = new Set(handlers.map((handler) => handler.transition.id));
	const { task, parts, taskOf, abortable } = createOperationRun({
		name,
		net,
		policy,
		handlerIds,
		handlers,
		retryDelayMs,
	});

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
			abort: async (operationId, context) => {
				const { log } = await state(context);
				const operation = startedOperations(handlerIds, log).find((started) => started.id === operationId);
				if (operation === undefined) {
					throw new Error(`no operation ${operationId} has started`);
				}
				if (!abortable(operation.transition)) {
					throw new Error(`${operation.transition} declares no variant aborted, so its tokens would stay taken`);
				}
				const taskId = await host.commit((tx) => taskOf(tx, conversationId, operationId), context);
				return host.abortTask(taskId, context);
			},
		};
	}

	return { extension: defineExtension({ name: `petrus:${name}`, tasks: [task] }), instance };
}
