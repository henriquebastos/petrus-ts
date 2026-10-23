import fc from "fast-check";
import type { Marking, Transition, TransitionId } from "@petrus/net";
import { fire, placeId, transitionId } from "@petrus/net";
import type { InstanceState, Runtime, RuntimeOptions } from "../src/index.ts";
import { createDisk, StoreCrashed } from "./controlled-store.ts";

/** Any function with the shape of `createRuntime`. Gate fixtures pass broken runtimes here. */
export type RuntimeFactory = (options: RuntimeOptions) => Runtime;

const ready = placeId("ready");
const left = placeId("left");
const right = placeId("right");

/** Two transitions compete for one token; a third returns it. */
export const contested: readonly Transition[] = [
	{ id: transitionId("take-left"), inputs: [{ place: ready, weight: 1 }], outputs: [{ place: left, weight: 1 }] },
	{ id: transitionId("take-right"), inputs: [{ place: ready, weight: 1 }], outputs: [{ place: right, weight: 1 }] },
	{ id: transitionId("give-back"), inputs: [{ place: left, weight: 1 }], outputs: [{ place: ready, weight: 1 }] },
];

export const initialState: InstanceState = { marking: { [ready]: 1 }, occurrences: [] };

const stepArbitrary: fc.Arbitrary<TransitionId> = fc.constantFrom(...contested.map((transition) => transition.id));

const fixedClock = { now: (): number => 1_000 };

/** Replays the occurrence log from the initial marking. A consistent state gives back its own marking. */
function replay(occurrences: InstanceState["occurrences"]): Marking | undefined {
	return occurrences.reduce<Marking | undefined>(replayOne, initialState.marking);
}

function replayOne(
	marking: Marking | undefined,
	occurrence: InstanceState["occurrences"][number],
): Marking | undefined {
	const transition = contested.find((candidate) => candidate.id === occurrence.transition);
	if (marking === undefined || transition === undefined) {
		return undefined;
	}
	const fired = fire(transition, marking);
	return fired.ok ? fired.value : undefined;
}

/** After a crash at any commit and a reopen, the stored marking is the replay of the stored log. */
export function crashCutProperty(factory: RuntimeFactory): fc.IAsyncProperty<[readonly TransitionId[], number]> {
	return fc.asyncProperty(fc.array(stepArbitrary, { maxLength: 8 }), fc.nat({ max: 8 }), async (steps, cut) => {
		const disk = createDisk(initialState);
		const first = factory({ transitions: contested, store: disk.open({ crashAtCommit: cut }), clock: fixedClock });
		const survivors: TransitionId[] = [];
		for (const step of steps) {
			const outcome = await first.step(step).catch((error: unknown) => {
				if (error instanceof StoreCrashed) {
					return "crashed" as const;
				}
				throw error;
			});
			if (outcome === "crashed") {
				break;
			}
			survivors.push(step);
		}
		const second = factory({ transitions: contested, store: disk.open(), clock: fixedClock });
		for (const step of steps.slice(survivors.length)) {
			await second.step(step);
		}
		return JSON.stringify(replay(disk.stored().occurrences)) === JSON.stringify(disk.stored().marking);
	});
}

/** Concurrent steps under every interleaving: each step the runtime acknowledged is in the stored log. */
export function raceProperty(factory: RuntimeFactory): fc.IAsyncProperty<[fc.Scheduler, readonly TransitionId[]]> {
	return fc.asyncProperty(
		fc.scheduler(),
		fc.array(stepArbitrary, { minLength: 2, maxLength: 4 }),
		async (scheduler, steps) => {
			const disk = createDisk(initialState);
			const raw = disk.open();
			const store = {
				load: scheduler.scheduleFunction(raw.load),
				commit: scheduler.scheduleFunction(raw.commit),
			};
			const runtime = factory({ transitions: contested, store, clock: fixedClock });
			const results = await scheduler.waitFor(Promise.all(steps.map((step) => runtime.step(step))));
			const acknowledged = results.filter((result) => result.ok).length;
			return acknowledged === disk.stored().occurrences.length;
		},
	);
}
