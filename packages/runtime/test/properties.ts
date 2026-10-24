import fc from "fast-check";
import type { ColourSet, Marking, Net, Place, SelectionPolicy, Transition } from "@petrus/petri-net";
import { addTokens, definitionOrder, fire, fireStep, placeId, transitionId } from "@petrus/petri-net";
import type {
	Batch,
	Ingress,
	LogEntry,
	NetInstanceState,
	NetInstanceStore,
	Runtime,
	RuntimeOptions,
	Stepped,
} from "../src/index.ts";
import { CommitFailed, createDisk, ReplyLost, StoreCrashed } from "./controlled-store.ts";

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

export const initialState: NetInstanceState = { marking: { [ready.id]: ["j1", "j2"] }, log: [] };

/** Policies that keep, reverse, or cut the candidates to one, so the competing transitions both get to fire. */
const policyArbitrary: fc.Arbitrary<SelectionPolicy> = fc.constantFrom<SelectionPolicy>(
	definitionOrder,
	(enabled) => [...enabled].reverse(),
	(enabled) => enabled.slice(0, 1),
);

const fixedClock = { now: (): number => 1_000 };

/** What a host asks for: a step, or a batch of job tokens for `ready`. */
type Action = "step" | Batch;

function batch(requestId: string, tokens: readonly string[]): Batch {
	return { requestId, tokens: { [ready.id]: tokens } };
}

/** The marking with every token of `tokens` added, place by place. */
function withAdded(marking: Marking, tokens: Marking): Marking {
	return Object.entries(tokens).reduce((sum, [place, more]) => addTokens(sum, placeId(place), more), marking);
}

/** Replays the log one entry at a time. A consistent state gives back its own marking. */
function replay(log: readonly LogEntry[]): Marking | undefined {
	return log.reduce<Marking | undefined>(
		(marking, entry) => (marking === undefined ? undefined : replayEntry(marking, entry)),
		initialState.marking,
	);
}

function replayEntry(marking: Marking, entry: LogEntry): Marking | undefined {
	if (entry.kind === "ingress") {
		return withAdded(marking, entry.tokens);
	}
	const transition = contested.transitions.find((candidate) => candidate.id === entry.transition);
	const fired = transition === undefined ? undefined : fire(transition, entry.binding, marking);
	return fired?.ok === true ? fired.value : undefined;
}

/** Equal markings: the same places with the same token lists. The order of places in the object does not count. */
function sameMarking(left: Marking | undefined, right: Marking): boolean {
	const sorted = (marking: Marking): string =>
		JSON.stringify(Object.entries(marking).sort(([a], [b]) => a.localeCompare(b)));
	return left !== undefined && sorted(left) === sorted(right);
}

/** The log without times, so a model that has no clock can give it. */
function untimed(log: readonly LogEntry[]): string {
	return JSON.stringify(
		log.map((entry) =>
			entry.kind === "ingress"
				? { requestId: entry.requestId, tokens: entry.tokens }
				: { transition: entry.transition, binding: entry.binding },
		),
	);
}

/** The untimed log of the actions, run in order from the initial marking with no fault. */
function modelLog(actions: readonly Action[], policy: SelectionPolicy): string {
	let marking = initialState.marking;
	const entries: unknown[] = [];
	for (const action of actions) {
		if (action === "step") {
			const step = fireStep(contested, marking, policy);
			marking = step.marking;
			entries.push(...step.fired);
		} else {
			marking = withAdded(marking, action.tokens);
			entries.push(action);
		}
	}
	return JSON.stringify(entries);
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
		const steps = Array.from({ length: count }, (): Action => "step");
		return sameMarking(replay(stored.log), stored.marking) && untimed(stored.log) === modelLog(steps, policy);
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

/** Steps and batches with fresh request ids, as a host sends them. */
const actionsArbitrary: fc.Arbitrary<readonly Action[]> = fc
	.array(fc.option(fc.array(fc.constantFrom("j1", "j2"), { minLength: 1, maxLength: 2 })), { maxLength: 6 })
	.map((choices) => choices.map((tokens, index) => (tokens === null ? "step" : batch(`r${String(index)}`, tokens))));

/** A store fault at one commit: the commit lands and its reply is lost, or it fails and does not land. */
type Fault = { readonly commit: number; readonly lands: boolean };

const faultArbitrary: fc.Arbitrary<Fault> = fc.record({ commit: fc.nat({ max: 8 }), lands: fc.boolean() });

/**
 * One commit fails: it lands and its reply is lost, or it does not land, and the host cannot tell which. The host
 * retries a batch with the same request id, on the same runtime or on a new one over the same disk, and goes on
 * after a step, since a step has no input. Each batch lands once, the stored log is the model's log of the calls
 * that landed, and each enqueue returned the ingress that the log holds, also after a retry.
 */
export function retryProperty(
	factory: RuntimeFactory,
): fc.IAsyncProperty<[readonly Action[], Fault, boolean, SelectionPolicy]> {
	return fc.asyncProperty(
		actionsArbitrary,
		faultArbitrary,
		fc.boolean(),
		policyArbitrary,
		async (actions, fault, reopen, policy) => {
			const disk = createDisk(initialState);
			let time = 0;
			const options = (store: NetInstanceStore): RuntimeOptions => ({
				net: contested,
				store,
				policy,
				clock: { now: () => (time += 1) },
			});
			const faults = fault.lands ? { loseReplyAtCommit: fault.commit } : { failAtCommit: fault.commit };
			const first = factory(options(disk.open(faults)));
			const retryOn = reopen ? (): Runtime => factory(options(disk.open())) : (): Runtime => first;
			const host = await runHost(first, retryOn, actions);
			const stored = disk.stored();
			const recorded = stored.log.filter((entry) => entry.kind === "ingress");
			return (
				sameMarking(replay(stored.log), stored.marking) &&
				untimed(stored.log) === modelLog(host.landed, policy) &&
				JSON.stringify(host.acknowledged) === JSON.stringify(recorded)
			);
		},
	);
}

/** What the host saw: the ingress of each batch, and the calls whose commit landed. */
type HostRun = { readonly acknowledged: readonly Ingress[]; readonly landed: readonly Action[] };

/** Runs the actions as a host does: it retries a failed batch on `retryOn()` and goes on after a failed step. */
async function runHost(first: Runtime, retryOn: () => Runtime, actions: readonly Action[]): Promise<HostRun> {
	let runtime = first;
	const acknowledged: Ingress[] = [];
	const landed: Action[] = [];
	for (const action of actions) {
		if (action === "step") {
			landed.push(...((await stepLanded(runtime)) ? [action] : []));
		} else {
			const ingress = await runtime.enqueue(action).catch(async (error: unknown) => {
				unlessStoreFault(error);
				runtime = retryOn();
				return runtime.enqueue(action);
			});
			acknowledged.push(ingress);
			landed.push(action);
		}
	}
	return { acknowledged, landed };
}

/** The test knows what the host cannot: whether a step whose call failed committed. */
async function stepLanded(runtime: Runtime): Promise<boolean> {
	try {
		await runtime.step();
		return true;
	} catch (error: unknown) {
		unlessStoreFault(error);
		return error instanceof ReplyLost;
	}
}

/** A lost reply or a failed commit is the fault under test. Any other error is a real failure. */
function unlessStoreFault(error: unknown): void {
	if (!(error instanceof ReplyLost || error instanceof CommitFailed)) {
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

/** Two request ids, each always with the same tokens, so sending one twice is a duplicate delivery. */
const deliveries: Readonly<Record<string, Batch>> = { r0: batch("r0", ["j1"]), r1: batch("r1", ["j2", "j1"]) };

/** Two to four steps and up to three of the request ids, in any order. */
function callsArbitrary(requestIds: readonly string[]): fc.Arbitrary<readonly string[]> {
	const chosen =
		requestIds.length === 0 ? fc.constant([]) : fc.array(fc.constantFrom(...requestIds), { maxLength: 3 });
	return fc.tuple(fc.integer({ min: 2, max: 4 }), chosen).chain(([steps, ids]) => {
		const calls = [...Array.from({ length: steps }, () => "step"), ...ids];
		return fc.shuffledSubarray(calls, { minLength: calls.length });
	});
}

/** Each entry without its time, sorted, so two logs with the same entries in another order compare equal. */
function untimedSet(entries: readonly LogEntry[]): string {
	return JSON.stringify(entries.map((entry) => untimed([entry])).sort());
}

/**
 * Concurrent steps and batches, with duplicate deliveries, under every interleaving: the stored marking is the
 * replay of the stored log, the log's occurrences are the acknowledged ones, each acknowledged ingress is in the
 * log, and each request id is there once. A gate for a step defect passes no request ids, so only steps race.
 */
export function raceProperty(
	factory: RuntimeFactory,
	requestIds: readonly string[] = Object.keys(deliveries),
): fc.IAsyncProperty<[fc.Scheduler, readonly string[], SelectionPolicy]> {
	return fc.asyncProperty(
		fc.scheduler(),
		callsArbitrary(requestIds),
		policyArbitrary,
		async (scheduler, calls, policy) => {
			const disk = createDisk(initialState);
			const store = scheduledStore(scheduler, disk.open());
			const runtime = factory({ net: contested, store, policy, clock: fixedClock });
			const { steps, enqueues } = issue(runtime, calls);
			const [stepped, ingresses] = await scheduler.waitFor(Promise.all([Promise.all(steps), Promise.all(enqueues)]));
			return raceHolds(disk.stored(), stepped, ingresses, new Set(calls.filter((call) => call !== "step")).size);
		},
	);
}

/** Starts every call at once, in the order given. */
function issue(
	runtime: Runtime,
	calls: readonly string[],
): { readonly steps: readonly Promise<Stepped>[]; readonly enqueues: readonly Promise<Ingress>[] } {
	const steps: Promise<Stepped>[] = [];
	const enqueues: Promise<Ingress>[] = [];
	for (const call of calls) {
		const delivery = deliveries[call];
		if (delivery === undefined) {
			steps.push(runtime.step());
		} else {
			enqueues.push(runtime.enqueue(delivery));
		}
	}
	return { steps, enqueues };
}

function raceHolds(
	stored: NetInstanceState,
	stepped: readonly Stepped[],
	ingresses: readonly Ingress[],
	distinctIds: number,
): boolean {
	const recorded = stored.log.filter((entry) => entry.kind === "ingress").map((entry) => JSON.stringify(entry));
	return (
		sameMarking(replay(stored.log), stored.marking) &&
		untimedSet(stepped.flatMap((result) => result.fired)) ===
			untimedSet(stored.log.filter((entry) => entry.kind === "occurrence")) &&
		ingresses.every((ingress) => recorded.includes(JSON.stringify(ingress))) &&
		recorded.length === distinctIds
	);
}
