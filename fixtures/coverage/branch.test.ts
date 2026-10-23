import { expect, test } from "vitest";
import { label } from "../src/branch.ts";

test("labels zero", () => {
	expect(label(0)).toBe("empty");
});
