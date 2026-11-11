import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import type {
	DocumentId,
	Extension,
	JsonObject,
	SessionEnd,
	Storage,
	StorageWrite,
	Wake,
} from "@earendil-works/pi-durable";
import { createRegistry, Harness, MemoryStorage, SessionFailed } from "@earendil-works/pi-durable";
import type { Batch, Clock, NetInstanceState, Runtime } from "../src/index.ts";
import type { NetInstanceRecord } from "../src/net-instance-record.ts";
import { netInstanceRecord, readNetInstance } from "../src/net-instance-record.ts";

/** More clock moves than any test needs: a settle that needs more never ends. */
const clockMoveLimit = 1_000;

/** The context of every Durable call in the tests. */
export const context: Context = BACKGROUND_CONTEXT;

/** The error of a process that died. */
export class Crashed extends Error {
	override readonly name = "Crashed";
}

/** Where a process dies, by its storage commit (counted from 0): before the commit lands, or right after. */
export type Faults = { readonly crashAtCommit?: number; readonly crashAfterCommit?: number };

/** A clock that only the test moves. A Harness and the runtimes over it share it. */
export type TestClock = Clock & { readonly moveTo: (at: number) => void };

export function createClock(start = 0): TestClock {
	let time = start;
	return {
		now: () => time,
		moveTo: (at) => {
			time = Math.max(time, at);
		},
	};
}

/** One process: its Harness, and the calls that run its tasks. */
export type Process = {
	readonly harness: Harness;
	/** Resumes scheduling and waits until no task can run now, without moving the clock. */
	readonly runReady: () => Promise<void>;
	/**
	 * Runs the ready tasks, moves the clock to the earliest sleep, and repeats until no task sleeps. It rejects with
	 * `Crashed` when the process dies, and with an error when the tasks still sleep after `clockMoveLimit` moves, as
	 * when a phase throws each time it runs.
	 */
	readonly settle: () => Promise<void>;
};

/**
 * Durable storage that survives a crash, and the clock of every process over it. Each `open` is a new process with a
 * new Harness over the same memory.
 */
export type Disk = {
	readonly clock: TestClock;
	readonly open: (faults?: Faults) => Promise<Process>;
	/** Each state of a net instance that a storage commit landed, in commit order, also when the process died after it. */
	readonly history: () => readonly NetInstanceState[];
	/** What the Harnesses reported: failed handler runs, faulted tasks, failed Sessions. */
	readonly reports: () => readonly unknown[];
};

export function createDisk(extensions: readonly Extension[], clock: TestClock = createClock()): Disk {
	const memory = new MemoryStorage();
	const history: NetInstanceState[] = [];
	const reports: unknown[] = [];
	const instances = new Set<DocumentId>();

	/** Reads back each net instance that a commit wrote, right after it lands: the history holds what storage holds. */
	async function recordInstances(writes: readonly StorageWrite[], callContext: Context): Promise<void> {
		for (const id of instanceWrites(writes, instances)) {
			const stored = await memory.document(id, "current", callContext);
			if (stored !== undefined && isNetInstanceRecord(stored.value)) {
				history.push(readNetInstance(stored.value));
			}
		}
	}

	async function open(faults: Faults = {}): Promise<Process> {
		const registry = createRegistry();
		for (const extension of extensions) {
			registry.install(extension);
		}
		const wakes = createWakes();
		const harness = await Harness.open(
			dyingStorage(memory, faults, recordInstances),
			{
				models: createModels(),
				registry,
				now: clock.now,
				onWake: wakes.changed,
				onReport: (error) => reports.push(error),
			},
			context,
		);
		const died = harness.closed.then((end) => {
			throw causeOf(end);
		});
		died.catch(() => undefined);
		const runReady = async (): Promise<void> => {
			harness.resume();
			await Promise.race([wakes.inactive(harness), died]);
		};
		const settle = async (): Promise<void> => {
			for (let moves = 0; moves < clockMoveLimit; moves += 1) {
				await runReady();
				const { at } = harness.wake();
				if (at === undefined) {
					return;
				}
				clock.moveTo(at);
			}
			throw new Error(`the tasks still sleep after ${String(clockMoveLimit)} clock moves`);
		};
		return { harness, runReady, settle };
	}

	return { clock, open, history: () => history, reports: () => reports };
}

/**
 * Runs `body` in a new process and closes its Harness. `crashed` when the process died under it: its storage threw
 * `Crashed`, and every later call got `SessionFailed` with that cause. Any other error is a real failure, and it
 * rejects.
 */
export async function inProcess(
	disk: Disk,
	faults: Faults,
	body: (process: Process) => Promise<void>,
): Promise<"done" | "crashed"> {
	const process = await disk.open(faults);
	try {
		await body(process);
		return "done";
	} catch (error: unknown) {
		if (isPlantedCrash(error)) {
			return "crashed";
		}
		throw error;
	} finally {
		await process.harness.close(context);
	}
}

/**
 * A host's run after a crash: a process that dies at `faults` enqueues `batch` and settles; after a crash, the clock
 * moves on by `outageMs` and a new process does the same, up to four processes. A batch that landed before the crash
 * adds nothing the second time. It returns the time at which each process opened.
 */
export async function enqueueAndSettle(
	disk: Disk,
	faults: Faults,
	runtime: Runtime,
	batch: Batch,
	outageMs = 0,
): Promise<readonly number[]> {
	const opened: number[] = [];
	let next = faults;
	for (let processes = 0; processes < 4; processes += 1) {
		opened.push(disk.clock.now());
		const outcome = await inProcess(disk, next, async ({ harness, settle }) => {
			const instance = runtime.instance(harness, (await harness.root(context)).id);
			await instance.enqueue(batch, context);
			await settle();
		});
		if (outcome === "done") {
			return opened;
		}
		next = {};
		disk.clock.moveTo(disk.clock.now() + outageMs);
	}
	return opened;
}

/** A planted fault, as storage threw it or as the failed Session carries it. */
function isPlantedCrash(error: unknown): boolean {
	return error instanceof Crashed || (error instanceof SessionFailed && error.cause instanceof Crashed);
}

/** Why a Session ended while a test waited on it: a planted crash, or a real failure that the test must see. */
function causeOf(end: SessionEnd): Error {
	if (end.reason === "closed") {
		return new Error("the Harness closed while the test waited on it");
	}
	if (isPlantedCrash(end.error)) {
		return new Crashed(String(end.error));
	}
	return end.error instanceof Error ? end.error : new Error(String(end.error));
}

type Wakes = { readonly changed: (wake: Wake) => void; readonly inactive: (harness: Harness) => Promise<void> };

/** Tells when no task of a Harness can run now, from its `onWake` calls. */
function createWakes(): Wakes {
	let waiting: (() => void)[] = [];
	return {
		changed: (wake) => {
			if (!wake.active) {
				const done = waiting;
				waiting = [];
				for (const resolve of done) {
					resolve();
				}
			}
		},
		inactive: (harness) =>
			harness.wake().active
				? new Promise((resolve) => {
						waiting.push(resolve);
					})
				: Promise.resolve(),
	};
}

type Landed = (writes: readonly StorageWrite[], callContext: Context) => Promise<void>;

/** Storage over `memory` for one process. It dies at the fault's commit; its close keeps the memory for the next. */
function dyingStorage(memory: MemoryStorage, faults: Faults, landed: Landed): Storage {
	let commits = 0;
	let dead = false;
	const commit: Storage["commit"] = async (writes, callContext) => {
		const index = commits;
		commits += 1;
		dead = dead || index === faults.crashAtCommit;
		if (dead) {
			throw new Crashed(`the process died at commit ${String(index)}`);
		}
		const seq = await memory.commit(writes, callContext);
		await landed(writes, callContext);
		if (index === faults.crashAfterCommit) {
			dead = true;
			throw new Crashed(`the process died after commit ${String(index)}`);
		}
		return seq;
	};
	return new Proxy(memory, {
		get: (target, property): unknown => {
			if (property === "commit") {
				return commit;
			}
			if (property === "close") {
				return () => Promise.resolve();
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** The ids of the net instance documents that `writes` create or change. It learns new ids into `instances`. */
function instanceWrites(writes: readonly StorageWrite[], instances: Set<DocumentId>): readonly DocumentId[] {
	return writes.flatMap((write) => {
		if (write.type === "document.create" && write.record.kind === netInstanceRecord.definition.kind) {
			instances.add(write.record.id);
			return [write.record.id];
		}
		return write.type === "document.change" && instances.has(write.id) ? [write.id] : [];
	});
}

function isNetInstanceRecord(value: JsonObject): value is NetInstanceRecord {
	const { net, stamp, marking, log, ingresses } = value;
	return (
		[net, stamp].every((field) => typeof field === "string") &&
		isObject(marking) &&
		Array.isArray(log) &&
		log.every(isObject) &&
		Array.isArray(ingresses)
	);
}

function isObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
