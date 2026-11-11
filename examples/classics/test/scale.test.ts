import fc from "fast-check";
import { expect, test } from "vitest";
import type { ScaleNet, ScaleRun } from "./scale.ts";
import { runAtScale } from "./scale.ts";

/**
 * Budgets on counts, never on time, of the runs that `pnpm scale` times. The number of storage commits and the size
 * of each write depend on how Durable batches and stores its records, so these budgets only bound their growth from
 * N to 2N; the slack is for Durable's own records, which do not grow with N. The log is the runtime's, so its length
 * is exact.
 */
const size = 20;
const nets: readonly ScaleNet[] = ["philosophers", "orders"];

const runs = new Map<string, Promise<ScaleRun>>();

/** The run of `net` at `runSize`, once for all the tests in this file. */
function runOnce(net: ScaleNet, runSize: number): Promise<ScaleRun> {
	const key = `${net} ${String(runSize)}`;
	const run = runs.get(key) ?? runAtScale(net, runSize);
	runs.set(key, run);
	return run;
}

/** A count of the run of `net` at `size` and at twice that size. */
async function atSizeAndDouble(net: ScaleNet, count: (run: ScaleRun) => number): Promise<readonly [number, number]> {
	return [count(await runOnce(net, size)), count(await runOnce(net, 2 * size))];
}

function largestWrite(run: ScaleRun): number {
	return run.writes.reduce((most, bytes) => Math.max(most, bytes), 0);
}

test("storage commits grow at most linearly: commits(2N) <= 2 commits(N) + 10, for both nets", async () => {
	for (const net of nets) {
		const [single, double] = await atSizeAndDouble(net, (run) => run.writes.length);
		expect(double, net).toBeLessThanOrEqual(2 * single + 10);
	}
});

test("the largest storage write grows at most linearly: largest(2N) <= 2 largest(N) + 1,000 bytes, for both nets", async () => {
	for (const net of nets) {
		const [single, double] = await atSizeAndDouble(net, largestWrite);
		expect(double, net).toBeLessThanOrEqual(2 * single + 1_000);
	}
});

/**
 * Each meal logs the occurrence of `eat`, its result's ingress and the occurrence of `ate`. Each order logs `Split`,
 * the occurrences of `CheckStock` and `Charge`, their results' ingresses and their variants' occurrences, then
 * `Ship`; a cancelled order, every third, logs the occurrence of `Undo`, its result's ingress and `undone` instead
 * of `Ship`. The first ingress comes before all of them.
 */
test("the final log has 3N + 1 entries for N philosophers, and 8N + 2 ceil(N / 3) + 1 for N orders", async () => {
	const philosophers = await atSizeAndDouble("philosophers", (run) => run.logLength);
	const orders = await atSizeAndDouble("orders", (run) => run.logLength);
	expect({ philosophers, orders }).toStrictEqual({
		philosophers: [3 * size + 1, 6 * size + 1],
		orders: [8 * size + 2 * Math.ceil(size / 3) + 1, 16 * size + 2 * Math.ceil((2 * size) / 3) + 1],
	});
});

test("the log-length formulas hold for generated sizes from 2 to 30", async () => {
	await fc.assert(
		fc.asyncProperty(fc.integer({ min: 2, max: 30 }), async (n) => {
			expect((await runAtScale("philosophers", n)).logLength).toBe(3 * n + 1);
			expect((await runAtScale("orders", n)).logLength).toBe(8 * n + 2 * Math.ceil(n / 3) + 1);
		}),
		{ numRuns: 8, examples: [[2], [3], [4]] },
	);
});
