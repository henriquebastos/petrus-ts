/**
 * `pnpm scale` runs the dining philosophers and the order process of examples/classics through the runtime on
 * Durable's memory storage, at each size, and prints what each run cost. It times the runs, so `pnpm feedback` does
 * not run it; the count budgets in examples/classics/test/scale.test.ts run the same setup at small sizes.
 * `SIZES` is a comma-separated list of sizes (default 100,300,1000). `WHICH` is philosophers, orders or both
 * (the default).
 */
import type { ScaleNet, ScaleRun } from "../examples/classics/test/scale.ts";
import { runAtScale } from "../examples/classics/test/scale.ts";

const netsOf: ReadonlyMap<string, readonly ScaleNet[]> = new Map([
	["philosophers", ["philosophers"]],
	["orders", ["orders"]],
	["both", ["philosophers", "orders"]],
]);

function sizesOf(text: string): readonly number[] {
	return text.split(",").map((size) => {
		if (!/^(?:[2-9]|[1-9]\d+)$/.test(size)) {
			throw new Error(`SIZES must be whole numbers of 2 or more with commas between them, not "${text}"`);
		}
		return Number(size);
	});
}

function netsNamed(text: string): readonly ScaleNet[] {
	const nets = netsOf.get(text);
	if (nets === undefined) {
		throw new Error(`WHICH must be philosophers, orders or both, not "${text}"`);
	}
	return nets;
}

function report(net: ScaleNet, size: number, ms: number, run: ScaleRun): string {
	const commits = run.writes.length;
	const largest = run.writes.reduce((most, bytes) => Math.max(most, bytes), 0);
	const total = run.writes.reduce((sum, bytes) => sum + bytes, 0);
	return [
		`${net} N=${String(size)}: total ${ms.toFixed(0)} ms`,
		`storage commits ${String(commits)}`,
		`${(ms / commits).toFixed(2)} ms/commit`,
		`largest write ${String(largest)} B`,
		`mean write ${(total / commits).toFixed(0)} B`,
		`log ${String(run.logLength)}`,
		`state ${String(run.stateBytes)} B`,
	].join(", ");
}

for (const size of sizesOf(process.env.SIZES ?? "100,300,1000")) {
	for (const net of netsNamed(process.env.WHICH ?? "both")) {
		const start = performance.now();
		const run = await runAtScale(net, size);
		console.log(report(net, size, performance.now() - start, run));
	}
}
