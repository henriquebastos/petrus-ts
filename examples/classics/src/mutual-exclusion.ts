import type { ColourSet, Marking, Net, Place, Token } from "@petrus/petri-net";
import { placeId, transitionId } from "@petrus/petri-net";
import type { Handler, HandlerTransition } from "@petrus/runtime";

/**
 * Processes that each use a shared resource once, one at a time. The one token on `mutex` is the resource token:
 * a process takes it to enter its critical section and gives it back when it leaves. The critical section is the
 * handler's work, so the token is held for the whole work: `mutex + critical:busy = 1` at every commit.
 */
const process: ColourSet = { name: "Process", contains: (token) => typeof token === "string" && /^p\d+$/.test(token) };
const lock: ColourSet = { name: "Lock", contains: (token) => token === "lock" };

const waiting: Place = { id: placeId("waiting"), colourSet: process };
export const mutex: Place = { id: placeId("mutex"), colourSet: lock };
export const finished: Place = { id: placeId("finished"), colourSet: process };

/** The critical section of one process. */
export const critical: HandlerTransition<"process" | "lock"> = {
	id: transitionId("critical"),
	variables: { process, lock },
	guard: () => true,
	inputs: [
		{ place: waiting, variables: ["process"] },
		{ place: mutex, variables: ["lock"] },
	],
	variants: {
		left: {
			value: process,
			outputs: [
				{ place: finished, expression: ({ process: done }) => [done] },
				{ place: mutex, expression: ({ lock: token }) => [token] },
			],
		},
	},
};

/** The net without its handler transition; the runtime adds it from `mutualExclusionHandlers`. */
export const mutualExclusion: Net = { places: [waiting, mutex, finished], transitions: [] };

/** `processCount` waiting processes, numbered from 1, and the free resource. */
export function initialMarking(processCount: number): Marking {
	return {
		[waiting.id]: Array.from({ length: processCount }, (_, index) => `p${String(index + 1)}`),
		[mutex.id]: ["lock"],
	};
}

/** The shared resource outside the net. The operation id names the holder, so a second run of one operation is the same holder. */
export type Resource = { readonly use: (process: Token, operationId: string) => Promise<void> };

export function mutualExclusionHandlers(resource: Resource): readonly Handler[] {
	const section: Handler<"process" | "lock"> = {
		transition: critical,
		run: async (binding, { operationId }) => {
			await resource.use(binding.process, operationId);
			return { variant: "left", value: binding.process };
		},
	};
	return [section];
}
