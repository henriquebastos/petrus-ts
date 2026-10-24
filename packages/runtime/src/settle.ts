import type { Stepped } from "./advance.ts";
import type { Handler, HandlerResult } from "./handlers.ts";
import type { Ingress, Occurrence } from "./net-instance.ts";
import type { Operation } from "./operations.ts";

/** The calls of a runtime that `settle` uses. Each one runs in the runtime's queue. */
export type SettleParts = {
	readonly step: () => Promise<Stepped>;
	readonly inFlight: () => Promise<readonly Operation[]>;
	readonly complete: (operationId: string, result: HandlerResult) => Promise<Ingress>;
};

/** Runs the net until it is quiet and returns what it fired. See `Runtime.settle`. */
export type Settle = () => Promise<readonly Occurrence[]>;

/** How one run ended. A failed run stays listed until a settle reports it. */
type Ended =
	| { readonly id: string; readonly failed: false }
	| { readonly id: string; readonly failed: true; readonly error: unknown };

type Round = { readonly quiet: true } | { readonly quiet: false; readonly fired: readonly Occurrence[] };

/**
 * Builds the settle of one runtime. It starts each operation in flight at most once per process: `started` keeps the
 * ids of runs that began here and did not fail, so a list read before a run's result landed cannot start it again.
 * A run whose handler throws or whose result does not commit is reported by one settle, and a later round of any
 * settle runs it again.
 */
export function createSettle(parts: SettleParts, handlers: readonly Handler[]): Settle {
	const started = new Set<string>();
	const running = new Map<string, Promise<Ended>>();

	function start(operation: Operation): void {
		started.add(operation.id);
		const ended = run(operation).then(
			(): Ended => {
				running.delete(operation.id);
				return { id: operation.id, failed: false };
			},
			(error: unknown): Ended => ({ id: operation.id, failed: true, error }),
		);
		running.set(operation.id, ended);
	}

	async function run(operation: Operation): Promise<void> {
		const handler = handlers.find((candidate) => candidate.transition.id === operation.transition);
		if (handler === undefined) {
			throw new Error(`no handler runs ${operation.transition}`);
		}
		const result = await handler.run(operation.binding, { operationId: operation.id });
		await parts.complete(operation.id, result);
	}

	function startNew(operations: readonly Operation[]): void {
		for (const operation of operations.filter((candidate) => !started.has(candidate.id))) {
			start(operation);
		}
	}

	async function nextRound(): Promise<Round> {
		startNew(await parts.inFlight());
		const stepped = await parts.step();
		if (stepped.fired.length > 0) {
			return { quiet: false, fired: stepped.fired };
		}
		if (running.size === 0) {
			return { quiet: true };
		}
		return reportEnded(await Promise.race(running.values()));
	}

	/** Only the first settle to see a failed run reports it; the others go on, and the next round runs it again. */
	function reportEnded(ended: Ended): Round {
		if (ended.failed && running.delete(ended.id)) {
			started.delete(ended.id);
			throw ended.error;
		}
		return { quiet: false, fired: [] };
	}

	return async () => {
		const fired: Occurrence[] = [];
		for (let round = await nextRound(); !round.quiet; round = await nextRound()) {
			fired.push(...round.fired);
		}
		return fired;
	};
}
