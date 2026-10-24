/**
 * Lets the Harness finish its commits and start the next work. The test types have no timers, so this runs
 * microtask turns. A handler's result, its commit and the start of the next handler's task take about 130 turns;
 * 1,000 leaves room, and a test that runs out of turns fails on its next assertion.
 */
export async function flush(): Promise<void> {
	for (let turn = 0; turn < 1_000; turn += 1) {
		await Promise.resolve();
	}
}
