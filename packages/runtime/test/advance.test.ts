import { definitionOrder, placeId, transitionId } from "@petrus/petri-net";
import { describe, expect, test } from "vitest";
import type { NetInstanceState } from "../src/index.ts";
import { advance } from "../src/advance.ts";
import { contested, initialState } from "./properties.ts";

describe("advance", () => {
	test("appends the step's occurrences to the log, each stamped with the given time", () => {
		const earlier = {
			kind: "occurrence" as const,
			transition: transitionId("give-back"),
			binding: { j: "j3" },
			at: 1,
		};
		const state: NetInstanceState = { ...initialState, log: [earlier] };
		const fired = [
			{ kind: "occurrence", transition: transitionId("take-left"), binding: { j: "j1" }, at: 7 },
			{ kind: "occurrence", transition: transitionId("take-left"), binding: { j: "j2" }, at: 7 },
		];
		expect(advance(contested, definitionOrder, state, 7)).toStrictEqual({
			fired,
			state: { marking: { [placeId("left")]: ["j1", "j2"] }, log: [earlier, ...fired] },
		});
		expect(state.log).toStrictEqual([earlier]);
	});

	test("returns the same state when nothing fires, so the runtime commits nothing", () => {
		const idle: NetInstanceState = { marking: { [placeId("right")]: ["j1"] }, log: [] };
		const stepped = advance(contested, definitionOrder, idle, 7);
		expect(stepped.fired).toStrictEqual([]);
		expect(stepped.state).toBe(idle);
	});
});
