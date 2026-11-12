import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { recordReview, scenarios } from "./record.ts";

const directory = resolve(process.argv[2] ?? ".amp/in/scratchpad/pr-review");
await mkdir(directory, { recursive: true });
for (const scenario of ["skip-b", "arrival-first", "selection-first"] as const) {
	const recording = await recordReview(scenario);
	await writeFile(resolve(directory, `pr-${scenario}.json`), JSON.stringify(recording));
	console.log(`${scenarios[scenario]}: ${JSON.stringify(recording.committedMarking.Reports)}`);
}
