import fc from "fast-check";
import { describe, test } from "vitest";
import { fire } from "../src/index.ts";
import { modelProperty } from "./model-property.ts";

describe("fire against a reference model", () => {
	test("any sequence of firings matches the model", () => {
		fc.assert(modelProperty(fire));
	});
});
