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
 * Where the store fails, by commit (counted from 0): the process crashes, a commit fails and does not land, or a
 * commit lands and its reply is lost.
 */
type Faults = {
	readonly crashAtCommit?: number;
	readonly failAtCommit?: number;
	readonly loseReplyAtCommit?: number;
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
			return {
				load: () => (crashed ? Promise.reject(new StoreCrashed("store is closed")) : Promise.resolve(stored)),
				commit: (state) => {
					const index = commits;
					if (crashed || index === faults.crashAtCommit) {
						crashed = true;
						return Promise.reject(new StoreCrashed(`crash at commit ${String(index)}`));
					}
					commits += 1;
					if (index === faults.failAtCommit) {
						return Promise.reject(new CommitFailed(`commit ${String(index)} failed`));
					}
					stored = state;
					return index === faults.loseReplyAtCommit
						? Promise.reject(new ReplyLost(`reply lost at commit ${String(index)}`))
						: Promise.resolve();
				},
			};
		},
	};
}
