/**
 * Lets the runtime finish its commits and start the next work. The test types have no timers, so this runs
 * microtask turns. A step needs about 60 turns; 200 leaves room, and a test that runs out of turns fails on its
 * next assertion.
 */
export async function flush(): Promise<void> {
	for (let turn = 0; turn < 200; turn += 1) {
		await Promise.resolve();
	}
}
