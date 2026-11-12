import type { Recording } from "@petrus/net-view-model";
import { projectNet } from "@petrus/net-view-model";
import { replay } from "@petrus/runtime-replay";
import { Value } from "typebox/value";
import { context, openDemo } from "./run.ts";
import type { Demo } from "./run.ts";
import { scriptedReview, snapshots } from "./snapshots.ts";

export const scenarios = {
	"skip-b": "PR review · skip B while A runs",
	"arrival-first": "PR review · C arrives before A settles",
	"selection-first": "PR review · B selected before C arrives",
};

/** Records actual native tasks under both committed orders of the selection race. */
export async function recordReview(scenario: keyof typeof scenarios): Promise<Recording> {
	const [a, b, c] = snapshots;
	const demo = await openDemo(scriptedReview);
	try {
		await demo.admit(a);
		await demo.runReady();
		await demo.admit(b);
		await demo.runReady();
		if (scenario === "selection-first") {
			demo.moveTo(10);
			await demo.runReady();
		}
		if (scenario === "arrival-first") demo.moveTo(10);
		await demo.admit(c);
		await demo.runReady();
		for (const time of [10, 20, 30]) {
			demo.moveTo(time);
			await demo.runReady();
		}
		return await recordingOf(demo, scenarios[scenario]);
	} finally {
		await demo.close();
	}
}

async function recordingOf(demo: Demo, title: string): Promise<Recording> {
	const state = await demo.instance.state(context);
	const frames = replay(demo.runtime.net, state.log);
	if (!Value.Equal(frames.at(-1)?.marking, state.marking)) throw new Error("Replay differs from committed state");
	if ((await demo.instance.inFlight(context)).length !== 0) throw new Error("The recording has unfinished reviews");
	return {
		format: "petrus-recording-1",
		title,
		source: "Deterministic scripted reviewer; real Petrus runtime and Durable tasks; no LLM calls",
		...projectNet(demo.runtime.net),
		frames,
		committedMarking: state.marking,
	};
}
