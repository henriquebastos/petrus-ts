import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { canFire } from "../src/guard.ts";

// The boundary test `canFire(1, 1)` is missing on purpose, so the `>=` to `>` mutant survives.
// Stryker selects the tests of a mutant by full name. The `describe` and the property keep two
// silent failures visible: a runner that builds names Vitest does not match, and a random seed in a name.
describe("canFire", () => {
	test("fires with spare tokens", () => {
		expect(canFire(2, 1)).toBe(true);
	});

	test.prop([fc.nat()])("does not fire below the requirement", (count) => {
		expect(canFire(count, count + 1)).toBe(false);
	});
});
