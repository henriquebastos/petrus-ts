import { half } from "@petrus/petri-net";
import { expect, test } from "vitest";

test("half of four is two", () => {
	expect(half(4)).toBe(2);
});
