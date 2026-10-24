import { describe, expect, test } from "vitest";
import { addTokens, emptyMarking, placeId, removeTokens, tokensAt } from "../src/index.ts";

const a = placeId("a");
const proto = placeId("__proto__");

describe("marking", () => {
	test("keeps tokens in arrival order and removes the first equal token", () => {
		const marking = addTokens(addTokens(emptyMarking, a, [1, { k: 2, j: 1 }]), a, [1]);
		expect(removeTokens(marking, a, [{ j: 1, k: 2 }, 1])).toStrictEqual({ [a]: [1] });
	});

	test("compares tokens by value at every depth, and arrays by order", () => {
		const marking = { [a]: [{ n: { x: 1, y: [1, 2] } }, [1, 2]] };
		expect(removeTokens(marking, a, [{ n: { y: [1, 2], x: 1 } }])).toStrictEqual({ [a]: [[1, 2]] });
		expect(() => removeTokens(marking, a, [{ n: { x: 2, y: [1, 2] } }])).toThrow(RangeError);
		expect(() => removeTokens(marking, a, [[2, 1]])).toThrow(RangeError);
	});

	test("removes a place that has no tokens left", () => {
		expect(removeTokens({ [a]: [1] }, a, [1])).toStrictEqual({});
	});

	test("reads only the marking's own places", () => {
		expect(tokensAt({}, placeId("constructor"))).toStrictEqual([]);
		expect(tokensAt(addTokens({}, proto, [1]), proto)).toStrictEqual([1]);
	});

	test("refuses to remove a token that is not there, which only a bug can cause", () => {
		expect(() => removeTokens({ [a]: [1] }, a, [1, 2, { x: 1 }])).toThrow(
			new RangeError('place a holds no token 2, {"x":1}'),
		);
	});
});
