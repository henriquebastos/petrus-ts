import { half } from "@petrus/net";
import { expect, test } from "vitest";

test("half of four is two", () => {
	expect(half(4)).toBe(2);
});
