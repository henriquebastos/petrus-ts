import { randomUUID } from "node:crypto";
import fc from "fast-check";
import type { Marking, Token } from "@petrus/petri-net";
import { definitionOrder, tokensAt } from "@petrus/petri-net";
import type { Runtime } from "@petrus/runtime";
import { busyPlaceId, createRuntime } from "@petrus/runtime";
import { describe, expect, test } from "vitest";
import type { Resource } from "../src/mutual-exclusion.ts";
import {
	critical,
	finished,
	initialMarking,
	mutex,
	mutualExclusion,
	mutualExclusionHandlers,
} from "../src/mutual-exclusion.ts";
import { clock, createDisk, runToEnd } from "./disk.ts";

type SharedResource = Resource & {
	/** Each time two holders were inside at once: their operation ids. */
	readonly overlaps: () => readonly (readonly string[])[];
	/** The process of each operation that used the resource and left. */
	readonly uses: () => ReadonlyMap<string, Token>;
};

/** A resource that records when two holders are inside. A holder is an operation, so a second run of one is the same holder. */
function sharedResource(pause: () => Promise<void>): SharedResource {
	const inside = new Map<string, number>();
	const overlaps: string[][] = [];
	const uses = new Map<string, Token>();
	const enter = (operationId: string): void => {
		inside.set(operationId, (inside.get(operationId) ?? 0) + 1);
		if (inside.size > 1) {
			overlaps.push([...inside.keys()]);
		}
	};
	const leave = (operationId: string): void => {
		const left = (inside.get(operationId) ?? 1) - 1;
		if (left === 0) {
			inside.delete(operationId);
		} else {
			inside.set(operationId, left);
		}
	};
	return {
		use: async (process, operationId) => {
			enter(operationId);
			await pause();
			leave(operationId);
			uses.set(operationId, process);
		},
		overlaps: () => overlaps,
		uses: () => uses,
	};
}

function runtimeOf(resource: Resource): Runtime {
	return createRuntime({
		name: "mutual-exclusion",
		nonce: randomUUID(),
		net: mutualExclusion,
		policy: definitionOrder,
		clock,
		handlers: mutualExclusionHandlers(resource),
		retryDelayMs: 0,
	});
}

/** The resource token is on `mutex` or held by the one process in its critical section. */
function oneHolder(marking: Marking): boolean {
	return tokensAt(marking, mutex.id).length + tokensAt(marking, busyPlaceId(critical.id)).length === 1;
}

describe("mutual exclusion", () => {
	test("lets each process in once, one at a time, and gives the resource token back", async () => {
		const disk = createDisk();
		const resource = sharedResource(() => Promise.resolve());
		await runToEnd(disk, runtimeOf(resource), initialMarking(3), undefined);
		expect(disk.last()).toStrictEqual({ [mutex.id]: ["lock"], [finished.id]: ["p1", "p2", "p3"] });
		expect(resource.overlaps()).toStrictEqual([]);
	});

	test("never has two holders inside, under any order of work and a crash at any commit", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.scheduler(),
				fc.integer({ min: 1, max: 4 }),
				fc.option(fc.nat({ max: 12 }), { nil: undefined }),
				async (scheduler, processCount, crashAt) => {
					const disk = createDisk();
					const resource = sharedResource(() => scheduler.schedule(Promise.resolve(), "inside"));
					await runToEnd(disk, runtimeOf(resource), initialMarking(processCount), crashAt, (settling) =>
						scheduler.waitFor(settling),
					);
					const processes = Array.from({ length: processCount }, (_, index) => `p${String(index + 1)}`);
					return (
						disk.history().every((state) => oneHolder(state)) &&
						resource.overlaps().length === 0 &&
						JSON.stringify([...tokensAt(disk.last(), finished.id)].sort()) === JSON.stringify(processes) &&
						JSON.stringify([...resource.uses().values()].sort()) === JSON.stringify(processes)
					);
				},
			),
		);
	});
});
