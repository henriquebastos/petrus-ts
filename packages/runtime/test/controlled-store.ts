import type fc from "fast-check";
import type { NetInstanceState, NetInstanceStore } from "../src/index.ts";

/** Thrown by a store whose process "died" at a commit. The commit did not land. */
export class StoreCrashed extends Error {
	override readonly name = "StoreCrashed";
}

/** Thrown by a commit that landed but whose reply was lost, as on a network timeout. The store stays open. */
export class ReplyLost extends Error {
	override readonly name = "ReplyLost";
}

/** Thrown by a commit that did not land, as on a refused write. The store stays open. */
export class CommitFailed extends Error {
	override readonly name = "CommitFailed";
}

/**
 * Where the store fails, by commit (counted from 0): the process crashes before the commit lands or right after,
 * a commit fails and does not land, or a commit lands and its reply is lost.
 */
type Faults = {
	readonly crashAtCommit?: number;
	readonly failAtCommit?: number;
	readonly loseReplyAtCommit?: number;
	readonly crashAfterCommit?: number;
};

/** What survives a crash. Each `open` is a new process that reads the same disk. */
export type Disk = {
	readonly stored: () => NetInstanceState;
	readonly open: (faults?: Faults) => NetInstanceStore;
};

export function createDisk(initial: NetInstanceState): Disk {
	let stored = initial;
	return {
		stored: () => stored,
		open: (faults = {}) => {
			let commits = 0;
			let crashed = false;
			/** Lands the commit, then fails as the faults say: a crash right after it, or a lost reply. */
			const land = (index: number, state: NetInstanceState): Error | undefined => {
				stored = state;
				if (index === faults.crashAfterCommit) {
					crashed = true;
					return new StoreCrashed(`crash after commit ${String(index)}`);
				}
				return index === faults.loseReplyAtCommit
					? new ReplyLost(`reply lost at commit ${String(index)}`)
					: undefined;
			};
			return {
				load: () => (crashed ? Promise.reject(new StoreCrashed("store is closed")) : Promise.resolve(stored)),
				commit: (state) => {
					const index = commits;
					if (crashed || index === faults.crashAtCommit) {
						crashed = true;
						return Promise.reject(new StoreCrashed(`crash at commit ${String(index)}`));
					}
					commits += 1;
					const failure =
						index === faults.failAtCommit
							? new CommitFailed(`commit ${String(index)} failed`)
							: land(index, state);
					return failure === undefined ? Promise.resolve() : Promise.reject(failure);
				},
			};
		},
	};
}

/**
 * A store whose reads and writes take effect only when the scheduler releases them, as with a real database.
 * (`scheduler.scheduleFunction` would run the call at once and delay only its answer, so writes would land early.)
 */
export function scheduledStore(scheduler: fc.Scheduler, raw: NetInstanceStore): NetInstanceStore {
	return {
		load: () => scheduler.schedule(Promise.resolve(), "load").then(raw.load),
		commit: (state) => scheduler.schedule(Promise.resolve(), "commit").then(() => raw.commit(state)),
	};
}
