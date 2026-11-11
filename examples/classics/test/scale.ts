import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai";
import type { Seq, StorageWrite } from "@earendil-works/pi-durable";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { Marking, Net, Token, Transition } from "@petrus/petri-net";
import { definitionOrder } from "@petrus/petri-net";
import type { Handler, NetInstanceState } from "@petrus/runtime";
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
	readonly stateHashes: readonly string[];
	readonly work: readonly { readonly guards: number; readonly tokenKeys: number }[];
};

type ScaleProbe = { readonly takeTokenKeys: () => number; readonly recordStates: boolean };

/** Runs `net` at `size` on Durable's memory storage until no task is left. Each handler's work ends at once. */
export function runAtScale(
	net: ScaleNet,
	size: number,
	probe: ScaleProbe = { takeTokenKeys: () => 0, recordStates: false },
): Promise<ScaleRun> {
	const names = (prefix: string): readonly string[] =>
		Array.from({ length: size }, (_, index) => `${prefix}${String(index)}`);
	if (net === "philosophers") {
		const handlers = diningPhilosophersHandlers(size, { eat: () => Promise.resolve() });
		return runToQuiet(diningPhilosophers, handlers, table(size, names("p")), probe);
	}
	const declined = new Set<Token>(names("o").filter((_, index) => index % 3 === 0));
	const shop = {
		reserve: () => Promise.resolve(true),
		charge: (order: Token) => Promise.resolve(!declined.has(order)),
		undo: () => Promise.resolve(),
	};
	return runToQuiet(orderProcess, orderProcessHandlers(shop), orders(names("o")), probe);
}

/** Memory storage that records the size of each commit. */
class CountingStorage extends MemoryStorage {
	readonly writes: number[] = [];

	override commit(writes: readonly StorageWrite[], commitContext: Context): Promise<Seq> {
		this.writes.push(JSON.stringify(writes).length);
		return super.commit(writes, commitContext);
	}
}

async function runToQuiet(
	net: Net,
	handlers: readonly Handler[],
	tokens: Marking,
	probe: ScaleProbe,
): Promise<ScaleRun> {
	let guards = 0;
	const countGuard = <T extends Pick<Transition, "guard">>(transition: T): T => ({
		...transition,
		guard: (binding) => {
			guards += 1;
			return transition.guard(binding);
		},
	});
	const options = {
		name: "scale",
		net: { ...net, transitions: net.transitions.map(countGuard) },
		policy: definitionOrder,
		clock,
		handlers: handlers.map((handler) => ({ ...handler, transition: countGuard(handler.transition) })),
		retryDelayMs: 0,
		nonce: randomUUID(),
	};
	const runtime = createRuntime(options);
	const registry = createRegistry();
	registry.install(runtime.extension);
	const storage = new CountingStorage();
	const harness = await Harness.open(storage, { models: createModels(), registry, now: clock.now }, context);
	try {
		const root = await harness.root(context);
		const instance = runtime.instance(harness, root.id);
		const stateHashes: Promise<string>[] = [];
		const work: { readonly guards: number; readonly tokenKeys: number }[] = [];
		probe.takeTokenKeys();
		harness.subscribeCommits((publication) => {
			const change = publication.changes.find(
				(change) => change.type === "document" && change.record.kind === "petrus.net-instance",
			);
			if (change?.type !== "document" || change.value === null) return;
			work.push({ guards, tokenKeys: probe.takeTokenKeys() });
			guards = 0;
			if (probe.recordStates) {
				const committed = JSON.stringify({ marking: change.value.marking, log: change.value.log });
				stateHashes.push(instance.state(context).then((state) => hashState(state, committed)));
			}
		});
		await instance.enqueue({ requestId: "first", tokens }, context);
		await harness.waitForIdle(context);
		const state = await instance.state(context);
		return {
			writes: storage.writes,
			logLength: state.log.length,
			stateBytes: JSON.stringify(state).length,
			stateHashes: await Promise.all(stateHashes),
			work,
		};
	} finally {
		await harness.close(context);
	}
}

/** Check the publication too, so an asynchronous state read cannot silently observe a later commit. */
function hashState(state: NetInstanceState, committed: string): string {
	const json = JSON.stringify(state);
	if (json !== committed) throw new Error("state() did not read the published net commit");
	return createHash("sha256").update(json).digest("hex");
}
