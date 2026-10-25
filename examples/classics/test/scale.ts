import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai";
import type { Seq, StorageWrite } from "@earendil-works/pi-durable";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { Marking, Net, Token } from "@petrus/petri-net";
import { definitionOrder } from "@petrus/petri-net";
import type { Handler } from "@petrus/runtime";
import { createRuntime } from "@petrus/runtime";
import { diningPhilosophers, diningPhilosophersHandlers, initialMarking as table } from "../src/dining-philosophers.ts";
import { initialMarking as orders, orderProcess, orderProcessHandlers } from "../src/order-process.ts";
import { clock, context } from "./disk.ts";

/** The nets that `pnpm scale` (scripts/scale.ts) and the count budgets in `test/scale.test.ts` run. */
export type ScaleNet = "philosophers" | "orders";

/**
 * What one run of a net cost, in counts. A run at size N has N philosophers, each eating once, or N orders. N is 2 or
 * more: with one philosopher, fork 0 is both forks, so nothing can eat.
 */
export type ScaleRun = {
	/** The size of the JSON of each storage commit, in commit order. The tokens are ASCII, so these are bytes. */
	readonly writes: readonly number[];
	readonly logLength: number;
	/** The size of the JSON of the final net-instance state, in bytes. */
	readonly stateBytes: number;
};

/** Runs `net` at `size` on Durable's memory storage until no task is left. Each handler's work ends at once. */
export function runAtScale(net: ScaleNet, size: number): Promise<ScaleRun> {
	const names = (prefix: string): readonly string[] =>
		Array.from({ length: size }, (_, index) => `${prefix}${String(index)}`);
	if (net === "philosophers") {
		const handlers = diningPhilosophersHandlers(size, { eat: () => Promise.resolve() });
		return runToQuiet(diningPhilosophers, handlers, table(size, names("p")));
	}
	const declined = new Set<Token>(names("o").filter((_, index) => index % 3 === 0));
	const shop = {
		reserve: () => Promise.resolve(true),
		charge: (order: Token) => Promise.resolve(!declined.has(order)),
		undo: () => Promise.resolve(),
	};
	return runToQuiet(orderProcess, orderProcessHandlers(shop), orders(names("o")));
}

/** Memory storage that records the size of each commit. */
class CountingStorage extends MemoryStorage {
	readonly writes: number[] = [];

	override commit(writes: readonly StorageWrite[], commitContext: Context): Promise<Seq> {
		this.writes.push(JSON.stringify(writes).length);
		return super.commit(writes, commitContext);
	}
}

async function runToQuiet(net: Net, handlers: readonly Handler[], tokens: Marking): Promise<ScaleRun> {
	const runtime = createRuntime({ name: "scale", net, policy: definitionOrder, clock, handlers, retryDelayMs: 0 });
	const registry = createRegistry();
	registry.install(runtime.extension);
	const storage = new CountingStorage();
	const harness = await Harness.open(storage, { models: createModels(), registry, now: clock.now }, context);
	try {
		const root = await harness.root(context);
		const instance = runtime.instance(harness, root.id);
		await instance.enqueue({ requestId: "first", tokens }, context);
		await harness.waitForIdle(context);
		const state = await instance.state(context);
		return { writes: storage.writes, logLength: state.log.length, stateBytes: JSON.stringify(state).length };
	} finally {
		await harness.close(context);
	}
}
