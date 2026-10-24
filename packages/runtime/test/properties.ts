import fc from "fast-check";
import type { Binding, ColourSet, Marking, Net, Place, Transition, TransitionId } from "@petrus/petri-net";
import { fire, placeId, transitionId } from "@petrus/petri-net";
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

/** Two transitions compete for each job token; a third returns it. */
export const contested: Net = {
	places: [ready, left, right],
	transitions: [move("take-left", ready, left), move("take-right", ready, right), move("give-back", left, ready)],
};

export const initialState: NetInstanceState = { marking: { [ready.id]: ["j1", "j2"] }, occurrences: [] };

/** One step: a transition and the binding it fires with. */
type Step = { readonly transition: TransitionId; readonly binding: Binding };

const stepArbitrary: fc.Arbitrary<Step> = fc.record({
	transition: fc.constantFrom(...contested.transitions.map((transition) => transition.id)),
	binding: fc.record({ j: fc.constantFrom("j1", "j2") }),
});

const fixedClock = { now: (): number => 1_000 };

function fireStep(marking: Marking, step: Step): Marking | undefined {
	const transition = contested.transitions.find((candidate) => candidate.id === step.transition);
	const fired = transition === undefined ? undefined : fire(transition, step.binding, marking);
	return fired?.ok === true ? fired.value : undefined;
}

/** Replays the occurrence log from the initial marking. A consistent state gives back its own marking. */
function replay(occurrences: NetInstanceState["occurrences"]): Marking | undefined {
	return occurrences.reduce<Marking | undefined>(
		(marking, occurrence) => (marking === undefined ? undefined : fireStep(marking, occurrence)),
		initialState.marking,
	);
}

/** The steps that fire when each step runs once, in order, from the initial marking. */
function modelLog(steps: readonly Step[]): readonly Step[] {
	const fired: Step[] = [];
	let marking = initialState.marking;
	for (const step of steps) {
		const next = fireStep(marking, step);
		if (next !== undefined) {
			marking = next;
			fired.push(step);
		}
	}
	return fired;
}

/**
 * After a crash at any commit and a reopen that runs the rest of the steps, the stored marking is the replay of the
 * stored log, and the log is what the model gives: the crashed step's commit did not land, so it ran again.
 */
export function crashCutProperty(factory: RuntimeFactory): fc.IAsyncProperty<[readonly Step[], number]> {
	return fc.asyncProperty(fc.array(stepArbitrary, { maxLength: 8 }), fc.nat({ max: 8 }), async (steps, cut) => {
		const disk = createDisk(initialState);
		const first = factory({ net: contested, store: disk.open({ crashAtCommit: cut }), clock: fixedClock });
		const survivors: Step[] = [];
		for (const step of steps) {
			const outcome = await first.step(step.transition, step.binding).catch((error: unknown) => {
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
		const second = factory({ net: contested, store: disk.open(), clock: fixedClock });
		for (const step of steps.slice(survivors.length)) {
			await second.step(step.transition, step.binding);
		}
		const stored = disk.stored();
		const consistent = JSON.stringify(replay(stored.occurrences)) === JSON.stringify(stored.marking);
		const log = stored.occurrences.map(({ transition, binding }) => ({ transition, binding }));
		return consistent && JSON.stringify(log) === JSON.stringify(modelLog(steps));
	});
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

/** Concurrent steps under every interleaving: each step the runtime acknowledged is in the stored log. */
export function raceProperty(factory: RuntimeFactory): fc.IAsyncProperty<[fc.Scheduler, readonly Step[]]> {
	return fc.asyncProperty(
		fc.scheduler(),
		fc.array(stepArbitrary, { minLength: 2, maxLength: 4 }),
		async (scheduler, steps) => {
			const disk = createDisk(initialState);
			const store = scheduledStore(scheduler, disk.open());
			const runtime = factory({ net: contested, store, clock: fixedClock });
			const results = await scheduler.waitFor(
				Promise.all(steps.map((step) => runtime.step(step.transition, step.binding))),
			);
			const acknowledged = results.filter((result) => result.ok).length;
			return acknowledged === disk.stored().occurrences.length;
		},
	);
}
