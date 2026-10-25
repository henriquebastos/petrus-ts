import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import type { CommitPublication } from "@earendil-works/pi-durable";
import { createRegistry, Harness, MemoryStorage, SessionFailed } from "@earendil-works/pi-durable";
import type { Marking } from "@petrus/petri-net";
import { placeId } from "@petrus/petri-net";
import type { Clock, NetInstance, Runtime } from "@petrus/runtime";
import { flush } from "./flush.ts";

/** The context of every Durable call in the tests. */
export const context: Context = BACKGROUND_CONTEXT;

/** A clock that only the disks move, and only forward. */
type TestClock = Clock & { readonly moveTo: (at: number) => void };

/**
 * The clock of the Harnesses and the runtimes. Only the timer of the simple protocol sleeps, and its wait counts from
 * the start of its operation, so the tests can share one clock.
 */
export const clock: TestClock = createClock();

function createClock(): TestClock {
	let time = 0;
	return {
		now: () => time,
		moveTo: (at) => {
			time = Math.max(time, at);
		},
	};
}

/** The error of a process that died. */
class Crashed extends Error {
	override readonly name = "Crashed";
}

/** One process over the disk: a new Harness, and the net instance in its root conversation. */
type Process = {
	readonly instance: NetInstance;
	/**
	 * Runs the ready tasks, moves the clock to the earliest sleep, and repeats until no task is left. It rejects with
	 * `Crashed` when the process died.
	 */
	readonly settle: () => Promise<void>;
	readonly close: () => Promise<void>;
};

/** Durable storage in memory that outlives a process, and the marking of each commit that landed on it. */
export type Disk = {
	/** A new process. It dies at its storage commit `crashAt` (counted from 0): that commit and every later one fail. */
	readonly open: (runtime: Runtime, crashAt?: number) => Promise<Process>;
	readonly history: () => readonly Marking[];
	readonly last: () => Marking;
};

/**
 * Durable storage in memory. `clockMoves`, when given, is where the clock may also move to the earliest sleep while
 * tasks run, so a scheduler can end a sleep before other work. After a settle one clock move stays scheduled, and
 * does nothing when its scheduler releases it.
 */
export function createDisk(clockMoves?: () => Promise<void>): Disk {
	const storage = new DiskStorage();
	const history: Marking[] = [];
	const record = (publication: CommitPublication): void => {
		for (const change of publication.changes) {
			if (change.type === "document" && change.record.kind === netInstanceKind && change.value !== null) {
				history.push(markingOf(change.value.marking));
			}
		}
	};
	return {
		open: async (runtime, crashAt = Number.POSITIVE_INFINITY) => {
			const registry = createRegistry();
			registry.install(runtime.extension);
			// The disk wakes every sleep itself (see `settled`), so the Harness arms no timer of its own.
			const options = { models: createModels(), registry, now: clock.now, onWake: () => undefined };
			storage.commitsLeft = crashAt;
			const harness = await Harness.open(storage, options, context);
			harness.subscribeCommits(record);
			const root = await harness.root(context).catch(async (error: unknown) => {
				await harness.close(context);
				throw error;
			});
			const instance = runtime.instance(harness, root.id);
			const settle = (): Promise<void> => settled(harness, clockMoves);
			return { instance, settle, close: () => harness.close(context) };
		},
		history: () => history,
		last: () => history.at(-1) ?? {},
	};
}

/**
 * Runs the net to the end: a process enqueues `tokens` and settles, and dies at commit `crashAt` when that is a
 * number. After a crash a new process enqueues the same batch, which adds nothing when it landed, and settles. `run`
 * wraps each process, so a scheduler can drive it. `during` runs in each process while it settles, as a host's
 * calls; the process settles again after it ends. A crash is `Crashed` from the storage, or `SessionFailed` from a
 * call after it, and only when `crashAt` planted one; any other error fails.
 */
export async function runToEnd(
	disk: Disk,
	runtime: Runtime,
	tokens: Marking,
	crashAt: number | undefined,
	run: (settling: Promise<void>) => Promise<void> = (settling) => settling,
	during: (instance: NetInstance) => Promise<void> = () => Promise.resolve(),
): Promise<void> {
	const once = async (dieAt?: number): Promise<void> => {
		const process = await disk.open(runtime, dieAt);
		try {
			await process.instance.enqueue({ requestId: "first", tokens }, context);
			const calls = during(process.instance);
			// After a crash the calls can end on the closed Harness; in a process that lives, the await still sees them.
			calls.catch(() => undefined);
			await process.settle();
			await calls;
			await process.settle();
		} finally {
			await process.close();
		}
	};
	await run(once(crashAt)).catch(async (error: unknown) => {
		if (crashAt === undefined || !isPlantedCrash(error)) {
			throw error;
		}
		await run(once());
	});
}

/** The kind of the Durable document that holds a net instance, so the history can tell it from Durable's own. */
const netInstanceKind = "petrus.net-instance";

/**
 * Runs the tasks, moving the clock to each sleep's end when no task can run, until no task is left. It rejects with
 * `Crashed` when the process dies first. With `clockMoves`, the clock also moves to the earliest sleep each time it
 * resolves.
 */
async function settled(harness: Harness, clockMoves?: () => Promise<void>): Promise<void> {
	const died = harness.closed.then((end) => {
		throw end.reason === "failed" && isPlantedCrash(end.error)
			? new Crashed("the process died")
			: new Error("the Session ended while the test waited on it", { cause: end });
	});
	died.catch(() => undefined);
	let done = false;
	const moveEarly = async (moves: () => Promise<void>): Promise<void> => {
		while (!done) {
			await moves();
			wakeEarliest(harness, done);
		}
	};
	if (clockMoves !== undefined) {
		moveEarly(clockMoves).catch(() => undefined);
	}
	try {
		for (;;) {
			harness.resume();
			await Promise.race([quiet(harness), died]);
			if (!wakeEarliest(harness, false)) {
				return;
			}
		}
	} finally {
		done = true;
	}
}

/** Moves the clock to the earliest sleep, and resumes the Harness. False when no task sleeps, or the settle ended. */
function wakeEarliest(harness: Harness, ended: boolean): boolean {
	if (ended) {
		return false;
	}
	const { at } = harness.wake();
	if (at === undefined) {
		return false;
	}
	clock.moveTo(at);
	harness.resume();
	return true;
}

/** Waits until no task of the Harness can run now. No test arms a timer, so it checks after each flush. */
async function quiet(harness: Harness): Promise<void> {
	while (harness.wake().active) {
		await flush();
	}
}

/**
 * Memory storage that outlives each process over it: its close keeps the memory for the next one. A process lets
 * `commitsLeft` commits land, and every later commit fails as a crash.
 */
class DiskStorage extends MemoryStorage {
	commitsLeft = Number.POSITIVE_INFINITY;

	override async commit(...call: Parameters<MemoryStorage["commit"]>): ReturnType<MemoryStorage["commit"]> {
		if (this.commitsLeft <= 0) {
			throw new Crashed("the process died");
		}
		this.commitsLeft -= 1;
		return super.commit(...call);
	}

	override close(): Promise<void> {
		return Promise.resolve();
	}
}

/** A planted crash, as the storage threw it or as the failed Session carries it. */
function isPlantedCrash(error: unknown): boolean {
	return error instanceof Crashed || (error instanceof SessionFailed && error.cause instanceof Crashed);
}

/**
 * The marking field of a stored net instance. A JSON value is a token, so only the shape needs a check. Another
 * shape throws: an empty marking would let an invariant pass without checking anything.
 */
function markingOf(stored: JsonValue | undefined): Marking {
	if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
		throw new TypeError("a stored net instance has no marking");
	}
	return Object.fromEntries(Object.entries(stored).map(([place, tokens]) => [placeId(place), placeTokens(tokens)]));
}

function placeTokens(tokens: JsonValue | undefined): JsonValue[] {
	if (!Array.isArray(tokens)) {
		throw new TypeError("a stored place holds no list of tokens");
	}
	return tokens;
}
