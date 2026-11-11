import { tokenKey } from "@petrus/petri-net";
import fc from "fast-check";
import { expect, test } from "vitest";
import type { ScaleNet, ScaleRun } from "./scale.ts";
import { runAtScale } from "./scale.ts";
import { countTokenKeys } from "./token-key-counter.ts";

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
	const run = runs.get(key) ?? measured(net, runSize);
	runs.set(key, run);
	return run;
}

async function measured(net: ScaleNet, runSize: number): Promise<ScaleRun> {
	const counter = countTokenKeys();
	try {
		// state() validates every busy token and calls guards, so hash capture must not enter the work budget.
		return await runAtScale(net, runSize, { takeTokenKeys: counter.take, recordStates: false });
	} finally {
		counter.close();
	}
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

test("the per-commit counters observe guards and token keys for both nets", async () => {
	for (const net of nets) {
		for (const n of [size, 2 * size]) {
			const run = await runOnce(net, n);
			expect(run.work).toHaveLength(net === "philosophers" ? n + 1 : 2 * n + Math.ceil(n / 3) + 1);
			expect(run.stateHashes).toStrictEqual([]);
			expect(run.work.slice(1).some((work) => work.guards > 0)).toBe(true);
			expect(run.work.slice(1).every((work) => work.tokenKeys > 0)).toBe(true);
		}
	}
});

test("the token-key counter counts calls once and resets after each measurement", () => {
	const counter = countTokenKeys();
	try {
		counter.take();
		tokenKey("one");
		tokenKey({ two: 2 });
		expect(counter.take()).toBe(2);
		expect(counter.take()).toBe(0);
	} finally {
		counter.close();
	}
});

function maximumWork(run: ScaleRun, field: "guards" | "tokenKeys"): number {
	return Math.max(...run.work.slice(1).map((work) => work[field]));
}

test.each(nets)("guard calls per commit after the first stay constant from N to 2N: %s", async (net) => {
	const [single, double] = await atSizeAndDouble(net, (run) => maximumWork(run, "guards"));
	expect(double).toBeLessThanOrEqual(single + 4);
});

test.each(nets)("token-key calls per commit after the first stay constant from N to 2N: %s", async (net) => {
	const [single, double] = await atSizeAndDouble(net, (run) => maximumWork(run, "tokenKeys"));
	expect(double).toBeLessThanOrEqual(single + 16);
});
