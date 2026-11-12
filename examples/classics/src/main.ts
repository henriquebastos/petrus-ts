import { createHash } from "node:crypto";
import { glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { recordReview, scenarios } from "@petrus/example-pr-review";
import { recordProducerConsumer } from "./record-producer-consumer.ts";
import { recordDiningPhilosophers } from "./record-dining-philosophers.ts";

// Logical time makes the recorded example independent of machine speed.
let time = 0;
const recording = await recordProducerConsumer(3, 2, { now: () => time++ });
const dining = await recordDiningPhilosophers({ now: () => time++ });
const root = fileURLToPath(new URL("../../../", import.meta.url));
const paths: string[] = [];
for await (const path of glob(["packages/*/src/**/*.ts", "examples/*/src/**/*.ts"], { cwd: root })) paths.push(path);
const hash = createHash("sha256");
for (const path of paths.sort()) {
	hash.update(path).update(await readFile(`${root}/${path}`));
}
const source = `Petrus TS source SHA-256 ${hash.digest("hex")}`;
const directory = new URL("../viewer/public/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL("run.json", directory), JSON.stringify({ ...recording, source }));
await writeFile(new URL("dining.json", directory), JSON.stringify({ ...dining, source }));
for (const scenario of ["skip-b", "arrival-first", "selection-first"] as const) {
	const review = await recordReview(scenario);
	await writeFile(
		new URL(`pr-${scenario}.json`, directory),
		JSON.stringify({ ...review, source: `${review.source}; ${source}` }),
	);
	console.log(`${scenarios[scenario]}: ${String(review.frames.length - 1)} log entries`);
}
console.log(`Recorded ${String(recording.frames.length - 1)} log entries through Petrus TS and Pi Durable.`);
console.log(`Replay matches committed marking: ${JSON.stringify(recording.committedMarking)}`);
console.log(`Dining replay matches committed marking: ${JSON.stringify(dining.committedMarking)}`);
console.log(source);
