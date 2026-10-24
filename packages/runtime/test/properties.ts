import fc from "fast-check";
import type { BindingElement, ColourSet, Marking, Net, Place, SelectionPolicy, Transition } from "@petrus/petri-net";
import { definitionOrder, fire, fireStep, placeId, transitionId } from "@petrus/petri-net";
import type { NetInstanceState, NetInstanceStore, Runtime, RuntimeOptions } from "../src/index.ts";
import { createDisk, StoreCrashed } from "./controlled-store.ts";

/** Any function with the shape of `createRuntime`. Gate fixtures pass broken runtimes here. */
export type RuntimeFactory = (options: RuntimeOptions) => Runtime;

const job: ColourSet = { name: "Job", contains: (token) => token === "j1" || token === "j2" };
export const ready: Place = { id: placeId("ready"), colourSet: job };
export const left: Place = { id: placeId("left"), colourSet: job };
const right: Place = { id: placeId("right"), colourSet: job };

export function move(id: string, from: Place, to: Place): Transition<"j"> {
	return {
		id: transitionId(id),
		variables: { j: job },
		guard: () => true,
		inputs: [{ place: from, variables: ["j"] }],
		outputs: [{ place: to, expression: ({ j }) => [j] }],
	};
}

/** Two transitions compete for each job token; a third returns it. The policy decides who wins. */
export const contested: Net = {
	places: [ready, left, right],
	transitions: [move("take-left", ready, left), move("take-right", ready, right), move("give-back", left, ready)],
};

export const initialState: NetInstanceState = { marking: { [ready.id]: ["j1", "j2"] }, occurrences: [] };

/** Policies that keep, reverse, or cut the candidates to one, so the competing transitions both get to fire. */
const policyArbitrary: fc.Arbitrary<SelectionPolicy> = fc.constantFrom<SelectionPolicy>(
	definitionOrder,
	(enabled) => [...enabled].reverse(),
	(enabled) => enabled.slice(0, 1),
);

const fixedClock = { now: (): number => 1_000 };

/** Replays the occurrence log one binding element at a time. A consistent state gives back its own marking. */
function replay(occurrences: NetInstanceState["occurrences"]): Marking | undefined {
	return occurrences.reduce<Marking | undefined>((marking, occurrence) => {
		const transition = contested.transitions.find((candidate) => candidate.id === occurrence.transition);
		const fired =
			marking === undefined || transition === undefined ? undefined : fire(transition, occurrence.binding, marking);
		return fired?.ok === true ? fired.value : undefined;
	}, initialState.marking);
}

/** Equal markings: the same places with the same token lists. The order of places in the object does not count. */
function sameMarking(left: Marking | undefined, right: Marking): boolean {
	const sorted = (marking: Marking): string =>
		JSON.stringify(Object.entries(marking).sort(([a], [b]) => a.localeCompare(b)));
	return left !== undefined && sorted(left) === sorted(right);
}

/** The binding elements that `count` steps fire, in order, from the initial marking. */
function modelLog(count: number, policy: SelectionPolicy): readonly BindingElement[] {
	const fired: BindingElement[] = [];
	let marking = initialState.marking;
	for (let index = 0; index < count; index += 1) {
		const step = fireStep(contested, marking, policy);
		marking = step.marking;
		fired.push(...step.fired);
	}
	return fired;
}

/**
 * After a crash at any commit and a reopen that runs the rest of the steps, the stored marking is the replay of the
 * stored log, and the log is what the model gives: the crashed step's commit did not land, so it ran again.
 */
export function crashCutProperty(factory: RuntimeFactory): fc.IAsyncProperty<[number, number, SelectionPolicy]> {
	return fc.asyncProperty(fc.nat({ max: 8 }), fc.nat({ max: 8 }), policyArbitrary, async (count, cut, policy) => {
		const disk = createDisk(initialState);
		const first = factory({ net: contested, store: disk.open({ crashAtCommit: cut }), policy, clock: fixedClock });
		let survivors = 0;
		while (survivors < count && (await stepSurvives(first))) {
			survivors += 1;
		}
		const second = factory({ net: contested, store: disk.open(), policy, clock: fixedClock });
		for (let index = survivors; index < count; index += 1) {
			await second.step();
		}
		const stored = disk.stored();
		const consistent = sameMarking(replay(stored.occurrences), stored.marking);
		const log = stored.occurrences.map(({ transition, binding }) => ({ transition, binding }));
		return consistent && JSON.stringify(log) === JSON.stringify(modelLog(count, policy));
	});
}

/** Runs one step; false when the store crashed under it. Any other error is a real failure. */
async function stepSurvives(runtime: Runtime): Promise<boolean> {
	try {
		await runtime.step();
		return true;
	} catch (error: unknown) {
		if (error instanceof StoreCrashed) {
			return false;
		}
		throw error;
	}
}

/**
 * A store whose reads and writes take effect only when the scheduler releases them, as with a real database.
 * (`scheduler.scheduleFunction` would run the call at once and delay only its answer, so writes would land early.)
 */
function scheduledStore(scheduler: fc.Scheduler, raw: NetInstanceStore): NetInstanceStore {
	return {
		load: () => scheduler.schedule(Promise.resolve(), "load").then(raw.load),
		commit: (state) => scheduler.schedule(Promise.resolve(), "commit").then(() => raw.commit(state)),
	};
}

/** Concurrent steps under every interleaving: each occurrence the runtime acknowledged is in the stored log. */
export function raceProperty(factory: RuntimeFactory): fc.IAsyncProperty<[fc.Scheduler, number, SelectionPolicy]> {
	return fc.asyncProperty(
		fc.scheduler(),
		fc.integer({ min: 2, max: 4 }),
		policyArbitrary,
		async (scheduler, count, policy) => {
			const disk = createDisk(initialState);
			const store = scheduledStore(scheduler, disk.open());
			const runtime = factory({ net: contested, store, policy, clock: fixedClock });
			const steps = Array.from({ length: count }, () => runtime.step());
			const results = await scheduler.waitFor(Promise.all(steps));
			const acknowledged = results.reduce((sum, result) => sum + result.fired.length, 0);
			return acknowledged === disk.stored().occurrences.length;
		},
	);
}
