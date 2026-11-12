import fc from "fast-check";
import { expect, onTestFinished, test } from "vitest";
import { readRecording } from "@petrus/net-view-model";
import { placeId } from "@petrus/petri-net";
import { replay } from "@petrus/runtime-replay";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { current, memories, reports as reportsPlace, Findings, Work } from "../src/net.ts";
import type { ReviewWork } from "../src/net.ts";
import { recordReview } from "../src/record.ts";
import { context, openDemo } from "../src/run.ts";
import { scriptedReview, snapshots } from "../src/snapshots.ts";

const revision = (seq: number): { readonly seq: number; readonly sha: string } => ({
	seq,
	sha: `revision-${String(seq)}`,
});
const finding = (seq: number): { readonly id: string; readonly note: string } => ({
	id: `f${String(seq)}`,
	note: `Review of ${String(seq)}`,
});

test.each([
	["skip-b", [1, 3]],
	["arrival-first", [1, 3]],
	["selection-first", [1, 2, 3]],
] as const)("records %s with the selected snapshots and replayed tokens", async (scenario, expected) => {
	const recording = await recordReview(scenario);
	expect(readRecording(recording)).toStrictEqual(recording);
	expect(recording.frames.at(-1)?.marking).toStrictEqual(recording.committedMarking);
	const reports = Value.Parse(
		Type.Array(Type.Object({ seq: Type.Number(), sha: Type.String(), findings: Findings })),
		recording.committedMarking.Reports,
	);
	expect(reports.map(({ seq }) => seq)).toStrictEqual(expected);
	expect(reports.map(({ sha }) => sha)).toStrictEqual(expected.map((seq) => snapshots[seq - 1]?.sha));
	expect(reports[0]?.findings).toEqual([
		{
			id: "tenant-access",
			note: "An administrator from another tenant can read the document. Require both conditions.",
		},
	]);
	expect(reports.at(-1)).toMatchObject({ findings: [] });
	expect(recording.committedMarking.Memory).toStrictEqual([{ reviewedSeq: 3, findings: [] }]);
	const selections = recording.frames
		.filter(({ label }) => label === "Select")
		.map(({ binding }) => Value.Parse(Work, binding));
	expect(selections.map(({ c }) => c.seq)).toStrictEqual(expected);
	expect(selections[1]).toMatchObject({ m: { findings: reports[0]?.findings } });
	const arrival = recording.frames.findIndex(({ label }) => label === "commit:3");
	const selectedB = recording.frames.findIndex(
		({ label, binding }) => label === "Select" && Value.Parse(Work, binding).c.seq === 2,
	);
	const finishedA = recording.frames.findIndex(({ label }) => label === "Review:reviewed");
	if (scenario === "selection-first") expect(selectedB).toBeLessThan(arrival);
	else expect(arrival).toBeLessThan(finishedA);
});

test("holds review memory while adoption continues and carries findings across skipped revisions", async () => {
	await fc.assert(
		fc.asyncProperty(fc.integer({ min: 2, max: 7 }), fc.integer({ min: 0, max: 4 }), async (selected, later) => {
			const seen: ReviewWork[] = [];
			const demo = await openDemo((work) => {
				seen.push(work);
				return [finding(work.c.seq)];
			});
			try {
				await demo.admit(revision(1));
				await demo.runReady();
				for (let seq = 2; seq <= selected; seq++) {
					await demo.admit(revision(seq));
					await demo.runReady();
				}
				const held = await demo.instance.state(context);
				expect(held.marking[current.id]).toStrictEqual([revision(selected)]);
				expect(held.marking[memories.id]).toBeUndefined();
				expect(held.marking[reportsPlace.id]).toBeUndefined();
				expect(seen).toStrictEqual([]);
				expect((await demo.instance.inFlight(context)).map(({ transition }) => transition)).toStrictEqual([
					"Review",
				]);
				demo.moveTo(10);
				await demo.runReady();
				expect(seen.map(({ c }) => c.seq)).toStrictEqual([1]);
				for (let seq = selected + 1; seq <= selected + later; seq++) {
					await demo.admit(revision(seq));
					await demo.runReady();
				}
				for (const time of [20, 30, 100]) {
					demo.moveTo(time);
					await demo.runReady();
				}
				const expected = later === 0 ? [1, selected] : [1, selected, selected + later];
				expect(seen.map(({ c }) => c.seq)).toStrictEqual(expected);
				expect(seen[1]).toMatchObject({ m: { reviewedSeq: 1, findings: [finding(1)] } });
				const state = await demo.instance.state(context);
				expect(state.marking[reportsPlace.id]).toStrictEqual(
					expected.map((seq) => ({ ...revision(seq), findings: [finding(seq)] })),
				);
				expect(state.marking[memories.id]).toStrictEqual([
					{ reviewedSeq: selected + later, findings: [finding(selected + later)] },
				]);
				expect(await demo.instance.inFlight(context)).toStrictEqual([]);
				expect(replay(demo.runtime.net, state.log).at(-1)).toMatchObject({ marking: state.marking });
			} finally {
				await demo.close();
			}
		}),
		{ numRuns: 12 },
	);
});

test("reviews one revision once and treats repeated admission as the same fact", async () => {
	const demo = await openDemo(() => []);
	onTestFinished(demo.close);
	await demo.admit(revision(1));
	await demo.runReady();
	demo.moveTo(10);
	await demo.runReady();
	const completed = await demo.instance.state(context);
	await demo.admit(revision(1));
	demo.moveTo(100);
	await demo.runReady();
	expect(await demo.instance.state(context)).toStrictEqual(completed);
	expect(completed.marking[reportsPlace.id]).toStrictEqual([{ ...revision(1), findings: [] }]);
	await expect(demo.admit({ seq: 1, sha: "different" })).rejects.toThrow();
	await expect(demo.admit({ seq: -1, sha: "invalid" })).rejects.toThrow();
});

test("adopts all queued revisions before selecting, regardless of token order", async () => {
	const demo = await openDemo(() => []);
	onTestFinished(demo.close);
	await demo.instance.enqueue(
		{ requestId: "batch", tokens: { [placeId("Commits")]: [revision(3), revision(1), revision(2)] } },
		context,
	);
	await demo.runReady();
	demo.moveTo(10);
	await demo.runReady();
	const state = await demo.instance.state(context);
	expect(state.marking[current.id]).toStrictEqual([revision(3)]);
	expect(state.marking[reportsPlace.id]).toStrictEqual([{ ...revision(3), findings: [] }]);
	expect(await demo.instance.inFlight(context)).toStrictEqual([]);
});

test("a review fault retains memory without stopping adoption or inventing a report", async () => {
	const demo = await openDemo(scriptedReview);
	onTestFinished(demo.close);
	await demo.admit(revision(1));
	await demo.runReady();
	demo.moveTo(10);
	await demo.runReady();
	await demo.admit(revision(2));
	await demo.runReady();
	const state = await demo.instance.state(context);
	expect(state.marking[current.id]).toStrictEqual([revision(2)]);
	expect(state.marking[memories.id]).toBeUndefined();
	expect(state.marking[reportsPlace.id]).toBeUndefined();
	expect(state.marking[placeId("Review:busy")]).toStrictEqual([
		{ w: { c: revision(1), m: { reviewedSeq: 0, findings: [] } } },
	]);
	expect((await demo.instance.inFlight(context)).map(({ transition }) => transition)).toStrictEqual(["Review"]);
	expect(replay(demo.runtime.net, state.log).at(-1)?.marking).toStrictEqual(state.marking);
});
