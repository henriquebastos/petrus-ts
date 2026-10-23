import { describe, expect, test } from "vitest";
import { addTokens, placeId } from "../src/index.ts";

const a = placeId("a");

describe("addTokens", () => {
	test("removes a place that reaches zero", () => {
		expect(addTokens({ [a]: 2 }, a, -2)).toStrictEqual({});
	});

	test("refuses a count below zero or a count that is not an integer, which only a bug can cause", () => {
		expect(() => addTokens({ [a]: 1 }, a, -2)).toThrow(new RangeError("place a would hold -1 tokens"));
		expect(() => addTokens({}, a, Number.NaN)).toThrow(RangeError);
	});
});
