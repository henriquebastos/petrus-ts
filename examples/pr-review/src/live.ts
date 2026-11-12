import { writeFile } from "node:fs/promises";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { opusReviewer } from "./opus.ts";
import { recordReview } from "./record.ts";

const output = process.argv[2];
if (output === undefined) throw new Error("Supply an output JSON path for the live recording");
const models = createModels();
models.setProvider(anthropicProvider());
const recording = await recordReview("skip-b", {
	run: opusReviewer(models),
	source:
		"Live Anthropic claude-opus-5-5; real Petrus runtime and Durable tasks; controlled admission and logical time",
});
await writeFile(output, JSON.stringify(recording));
console.log(JSON.stringify(recording.committedMarking.Reports));
