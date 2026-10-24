import type { NetInstanceState, NetInstanceStore } from "@petrus/runtime";

/** The error of a store whose process died. */
export class Crashed extends Error {
	override readonly name = "Crashed";
}

/** A disk that keeps every committed state, so a test can check an invariant at each one. */
export type HistoryDisk = {
	readonly history: () => readonly NetInstanceState[];
	readonly last: () => NetInstanceState;
	/** A store over the disk. The process dies at commit `dieAt` (counted from 0): it does not land, and the store closes. */
	readonly open: (dieAt?: number) => NetInstanceStore;
};

export function historyDisk(first: NetInstanceState): HistoryDisk {
	const history = [first];
	const last = (): NetInstanceState => history[history.length - 1] ?? first;
	return {
		history: () => history,
		last,
		open: (dieAt = Number.POSITIVE_INFINITY) => {
			let commits = 0;
			let alive = true;
			const write = (state: NetInstanceState): void => {
				alive = alive && commits !== dieAt;
				commits += 1;
				if (!alive) {
					throw new Crashed(`died at commit ${String(commits - 1)}`);
				}
				history.push(state);
			};
			return {
				load: () => (alive ? Promise.resolve(last()) : Promise.reject(new Crashed("the process is gone"))),
				// A throw in the executor rejects the promise, as a store's failed write does.
				commit: (state) =>
					new Promise<void>((resolve) => {
						write(state);
						resolve();
					}),
			};
		},
	};
}
