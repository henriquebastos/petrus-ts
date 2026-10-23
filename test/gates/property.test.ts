import fc from "fast-check";
import { expect, test } from "vitest";
import { fireOffByOne } from "../../fixtures/property/fire-off-by-one.ts";
import { modelProperty } from "../../packages/net/test/model-property.ts";

test("the model property finds the planted off-by-one, shrinks it, and replays it from the seed", () => {
	const first = fc.check(modelProperty(fireOffByOne));
	expect(first.failed).toBe(true);
	expect(first.numShrinks).toBeGreaterThan(0);
	const replayed = fc.check(modelProperty(fireOffByOne), { seed: first.seed });
	expect(replayed.failed).toBe(true);
	expect(fc.stringify(replayed.counterexample)).toBe(fc.stringify(first.counterexample));
});
