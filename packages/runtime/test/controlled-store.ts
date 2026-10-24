import type { NetInstanceState, NetInstanceStore } from "../src/index.ts";

/** Thrown by a store whose process "died" at a commit. The commit did not land. */
export class StoreCrashed extends Error {
	override readonly name = "StoreCrashed";
}

/** What survives a crash. Each `open` is a new process that reads the same disk. */
export type Disk = {
	readonly stored: () => NetInstanceState;
	readonly open: (options?: { readonly crashAtCommit?: number }) => NetInstanceStore;
};

export function createDisk(initial: NetInstanceState): Disk {
	let stored = initial;
	return {
		stored: () => stored,
		open: (options = {}) => {
			let commits = 0;
			let crashed = false;
			return {
				load: () => (crashed ? Promise.reject(new StoreCrashed("store is closed")) : Promise.resolve(stored)),
				commit: (state) => {
					if (crashed || commits === options.crashAtCommit) {
						crashed = true;
						return Promise.reject(new StoreCrashed(`crash at commit ${String(commits)}`));
					}
					commits += 1;
					stored = state;
					return Promise.resolve();
				},
			};
		},
	};
}
