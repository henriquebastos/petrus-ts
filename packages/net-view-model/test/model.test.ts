import { expect, test } from "vitest";
import { inspectMarking, projectNet, readRecording, viewTokens } from "../src/index.ts";

test("displays an empty net and treats prototype names as token keys", () => {
	const net = { places: [], transitions: [] };
	const empty = {
		format: "petrus-recording-1",
		title: "Empty",
		source: "test",
		...projectNet(net),
		frames: [inspectMarking(net, {})],
		committedMarking: {},
	};
	expect(readRecording(empty)).toStrictEqual(empty);
	expect(viewTokens({}, "toString")).toStrictEqual([]);
	expect(viewTokens({ constructor: [1, 1] }, "constructor")).toStrictEqual([1, 1]);
	expect(() => readRecording({ ...empty, frames: [] })).toThrow("invalid format");
});
