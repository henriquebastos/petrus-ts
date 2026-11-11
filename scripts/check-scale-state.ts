import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import type { ScaleNet } from "../examples/classics/test/scale.ts";
import { runAtScale } from "../examples/classics/test/scale.ts";
import { parseJson } from "./json.ts";

const baselineRevision = "88e246b";
const path = new URL("../examples/classics/test/scale-state-baseline.json", import.meta.url);
const schema = Type.Array(
	Type.Object({
		net: Type.Union([Type.Literal("philosophers"), Type.Literal("orders")]),
		size: Type.Number(),
		hashes: Type.Array(Type.String()),
	}),
);
const nets: readonly ScaleNet[] = ["philosophers", "orders"];
const results = [];
for (const size of [100, 300]) {
	for (const net of nets) {
		const start = performance.now();
		const run = await runAtScale(net, size, { takeTokenKeys: () => 0, recordStates: true });
		results.push({ net, size, hashes: run.stateHashes });
		console.error(
			`${net} N=${String(size)}: ${String(run.stateHashes.length)} net commits, ${(performance.now() - start).toFixed(0)} ms`,
		);
	}
}
if (process.argv.includes("--record")) {
	assert.equal(execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim(), baselineRevision);
	writeFileSync(path, `${JSON.stringify(results, null, "\t")}\n`);
} else {
	assert.deepEqual(results, parseJson(readFileSync(path, "utf8"), schema));
	console.log(`Every committed state matches ${baselineRevision}.`);
}
