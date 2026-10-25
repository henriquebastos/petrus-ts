import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { fireOffByOne } from "../../fixtures/property/fire-off-by-one.ts";
import { fireWithoutExpressionArcs } from "../../fixtures/property/fire-without-expression-arcs.ts";
import type { Fire } from "../../packages/petri-net/test/model-property.ts";
import { modelProperty } from "../../packages/petri-net/test/model-property.ts";

describe("the model property finds a planted defect, shrinks it, and replays it from the seed", () => {
	test.each<[string, Fire]>([
		["the planted off-by-one", fireOffByOne],
		["the planted enabled check without expression input arcs", fireWithoutExpressionArcs],
	])("%s", (_name, fireUnderTest) => {
		const first = fc.check(modelProperty(fireUnderTest));
		expect(first.failed).toBe(true);
		expect(String(first.errorInstance)).toMatch(/fire said ok=|fire gave/);
		expect(first.numShrinks).toBeGreaterThan(0);
		const replayed = fc.check(modelProperty(fireUnderTest), { seed: first.seed });
		expect(replayed.failed).toBe(true);
		expect(fc.stringify(replayed.counterexample)).toBe(fc.stringify(first.counterexample));
	});
});
