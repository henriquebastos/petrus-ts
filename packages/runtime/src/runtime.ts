import type { Net, SelectionPolicy } from "@petrus/petri-net";
import { markingProblems, netProblems } from "@petrus/petri-net";
import type { Admitted } from "./admit.ts";
import { admit } from "./admit.ts";
import type { Stepped } from "./advance.ts";
import { advance } from "./advance.ts";
import type { Handler, HandlerResult } from "./handlers.ts";
import { withHandlers } from "./handlers.ts";
import type { Batch, Ingress, NetInstanceState, NetInstanceStore, Occurrence } from "./net-instance.ts";
import type { Operation } from "./operations.ts";
import { admitResult, hostBatchProblems, operationsInFlight } from "./operations.ts";
import type { Clock } from "./seams.ts";
import { createSettle } from "./settle.ts";
import { createSerialQueue } from "./serial-queue.ts";

/** One running net instance. */
export type Runtime = {
	/**
	 * Selects a step with the policy, fires it, and commits the new marking and its occurrences together.
	 * When nothing is enabled it fires nothing and commits nothing. A step that fires a handler transition starts an
	 * operation, but it does not run the handler: `settle` does. Steps run one at a time.
	 */
	readonly step: () => Promise<Stepped>;
	/**
	 * Adds a batch of tokens from outside and records its ingress in the same commit. A batch whose request id the
	 * log already holds adds nothing and returns the recorded ingress, so a retry after a lost reply is safe.
	 * It does not step: the host calls `step` or `settle`.
	 */
	readonly enqueue: (batch: Batch) => Promise<Ingress>;
	/** The operations that the stored log started and has no result for, in log order. */
	readonly inFlight: () => Promise<readonly Operation[]>;
	/**
	 * Records an operation's result: its token goes on the handler transition's result place, in one commit with its
	 * ingress. The first result counts; a later one returns the recorded ingress. It does not step.
	 */
	readonly complete: (operationId: string, result: HandlerResult) => Promise<Ingress>;
	/**
	 * Runs the net until it is quiet: it runs the handler of each operation in flight, records each result with
	 * `complete`, and steps, until a step fires nothing and no handler runs. It returns what its steps fired.
	 * It rejects with the error of a failed load or step, or of a run whose handler threw or whose result did not
	 * commit. A failed run is reported by one settle; the operation stays in flight, and the next round of any settle
	 * runs it again. A net that never stops firing makes it run forever.
	 */
	readonly settle: () => Promise<readonly Occurrence[]>;
};

/**
 * What a runtime needs: the net, the store of its net instance, the policy that orders and filters the enabled
 * binding elements, the clock that stamps the log, and the handler transitions with their handlers.
 */
export type RuntimeOptions = {
	readonly net: Net;
	readonly store: NetInstanceStore;
	readonly policy: SelectionPolicy;
	readonly clock: Clock;
	readonly handlers?: readonly Handler[];
};

/**
 * Builds a runtime for one net instance. The runtime runs the plain net that `withHandlers` makes from the net and
 * the handler transitions. A net with problems (see `netProblems`) is a bug, so it throws.
 * A stored marking with problems (see `markingProblems`) is a bug too: the call rejects.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
	const { store, policy, clock, handlers = [] } = options;
	const net = withHandlers(
		options.net,
		handlers.map((handler) => handler.transition),
	);
	const problems = netProblems(net);
	if (problems.length > 0) {
		throw new Error(`invalid net: ${problems.join("; ")}`);
	}
	const handlerIds = new Set(handlers.map((handler) => handler.transition.id));
	const serial = createSerialQueue();

	async function load(): Promise<NetInstanceState> {
		const state = await store.load();
		const wrong = markingProblems(net, state.marking);
		if (wrong.length > 0) {
			throw new Error(`invalid stored marking: ${wrong.join("; ")}`);
		}
		return state;
	}

	async function stepNow(): Promise<Stepped> {
		const state = await load();
		const stepped = advance(net, policy, state, clock.now());
		if (stepped.state !== state) {
			await store.commit(stepped.state);
		}
		return stepped;
	}

	async function committed(admitted: Admitted): Promise<Ingress> {
		if (admitted.kind === "applied") {
			await store.commit(admitted.state);
		}
		return admitted.ingress;
	}

	async function enqueueNow(batch: Batch): Promise<Ingress> {
		const reserved = hostBatchProblems(handlerIds, batch);
		if (reserved.length > 0) {
			throw new Error(`invalid batch ${batch.requestId}: ${reserved.join("; ")}`);
		}
		return committed(admit(net, await load(), batch, clock.now()));
	}

	async function completeNow(operationId: string, result: HandlerResult): Promise<Ingress> {
		return committed(admitResult(net, handlerIds, await load(), operationId, result, clock.now()));
	}

	const parts = {
		step: () => serial(stepNow),
		inFlight: () => serial(async () => operationsInFlight(handlerIds, (await load()).log)),
		complete: (operationId: string, result: HandlerResult) => serial(() => completeNow(operationId, result)),
	};
	return { ...parts, enqueue: (batch) => serial(() => enqueueNow(batch)), settle: createSettle(parts, handlers) };
}
