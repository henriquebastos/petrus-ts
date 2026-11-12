import { strict as assert } from "node:assert";
import { replay } from "../packages/runtime-replay/src/index.ts";
import type { ScaleNet } from "../examples/classics/test/scale.ts";
import { runAtScale } from "../examples/classics/test/scale.ts";

// Native starts and ends change traces. Keep the historical synchronous hashes, rather than replacing them.
assert.ok(!process.argv.includes("--record"), "native replay verification does not replace historical state hashes");
const nets: readonly ScaleNet[] = ["philosophers", "orders"];
let checked = 0;
for (const size of [100, 300]) {
	for (const net of nets) {
		const start = performance.now();
		const run = await runAtScale(net, size, { takeTokenKeys: () => 0, recordStates: true });
		const frames = replay(run.net, run.state.log);
		assert.ok(run.states.length > 0);
		for (const state of run.states) {
			assert.deepEqual(state.log, run.state.log.slice(0, state.log.length));
			assert.deepEqual(frames.at(state.log.length)?.marking, state.marking);
		}
		assert.deepEqual(frames.at(-1)?.marking, run.state.marking);
		checked += run.states.length;
		console.log(
			`${net} N=${String(size)}: ${String(run.states.length)} net commits, ${String(run.taskCount)} tasks, ` +
				`${String(run.writes.length)} storage commits, ${(performance.now() - start).toFixed(0)} ms`,
		);
	}
}
console.log(
	`${String(checked)} committed states match expanded-net replay. Historical synchronous hashes are unchanged.`,
);
