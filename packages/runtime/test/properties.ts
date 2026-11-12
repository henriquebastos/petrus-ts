import type { Harness } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import type { ColourSet, Marking, Net, Place, SelectionPolicy, Transition } from "@petrus/petri-net";
import { definitionOrder, fireStep, placeId, transitionId } from "@petrus/petri-net";
import type {
	Batch,
	Committed,
	Ingress,
	NetInstanceHost,
	LogEntry,
	NetInstanceState,
	Runtime,
	RuntimeOptions,
} from "../src/index.ts";
import type { Faults, TestClock } from "./disk.ts";
import { context, createClock, createDisk, inProcess } from "./disk.ts";
import { replay, sameMarking, withAdded } from "./replay.ts";

/** Any function with the shape of `createRuntime`. Gate fixtures pass broken runtimes here. */
export type RuntimeFactory = (options: RuntimeOptions) => Runtime;

const job: ColourSet = { name: "Job", contains: (token) => token === "j1" || token === "j2" };
export const ready: Place = { id: placeId("ready"), colourSet: job };
export const left: Place = { id: placeId("left"), colourSet: job };
export const right: Place = { id: placeId("right"), colourSet: job };

export function move(id: string, from: Place, to: Place): Transition<"j"> {
	return {
		id: transitionId(id),
		variables: { j: job },
		guard: () => true,
		inputs: [{ place: from, variables: ["j"] }],
		outputs: [{ place: to, expression: ({ j }) => [j] }],
	};
}

/** Two transitions compete for each job token. The policy decides who wins. */
export const contested: Net = {
	places: [ready, left, right],
	transitions: [move("take-left", ready, left), move("take-right", ready, right)],
};

export const initialState: NetInstanceState = { marking: { [ready.id]: ["j1", "j2"] }, log: [] };

const count: ColourSet = { name: "Count", contains: (token) => typeof token === "number" && Number.isInteger(token) };
export const counted: Place = { id: placeId("count"), colourSet: count };

/** A token on `count` goes up by one per step, from where it starts to `top`: a net that fires for `top` steps from 0. */
export function counter(top: number): Net {
	const tick: Transition<"n"> = {
		id: transitionId("tick"),
		variables: { n: count },
		guard: ({ n }) => typeof n === "number" && n < top,
		inputs: [{ place: counted, variables: ["n"] }],
		outputs: [{ place: counted, expression: ({ n }) => [typeof n === "number" ? n + 1 : n] }],
	};
	return { places: [counted], transitions: [tick] };
}

/** Policies that keep, reverse, or cut the candidates to one, so the competing transitions both get to fire. */
const policyArbitrary: fc.Arbitrary<SelectionPolicy> = fc.constantFrom<SelectionPolicy>(
	definitionOrder,
	(enabled) => [...enabled].reverse(),
	(enabled) => enabled.slice(0, 1),
);

/** One crash of the first process: before its storage commit `commit` lands, or right after. */
export type Fault = { readonly kind: keyof Faults; readonly commit: number };

export function faultArbitrary(maxCommit: number): fc.Arbitrary<Fault> {
	return fc.record({
		kind: fc.constantFrom<keyof Faults>("crashAtCommit", "crashAfterCommit"),
		commit: fc.nat({ max: maxCommit }),
	});
}

export function contestedOptions(policy: SelectionPolicy, clock: TestClock): RuntimeOptions {
	return { name: "contested", nonce: randomUUID(), net: contested, policy, clock, executions: [], startLimit: 100 };
}

function batch(requestId: string, tokens: readonly string[]): Batch {
	return { requestId, tokens: { [ready.id]: tokens } };
}

const noInstance: NetInstanceState = { marking: {}, log: [] };

/** The last committed state, or no tokens and an empty log when nothing committed. */
export function lastState(history: readonly NetInstanceState[]): NetInstanceState {
	return history.at(-1) ?? noInstance;
}

/**
 * At every commit the marking is the replay of the log, from no tokens, and the net is quiet: the policy selects
 * nothing.
 */
export function everyCommitHeld(net: Net, policy: SelectionPolicy, history: readonly NetInstanceState[]): boolean {
	return history.every(
		(state) =>
			sameMarking(replay(net, {}, state.log), state.marking) &&
			fireStep(net, state.marking, policy).fired.length === 0,
	);
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

/** The untimed log of the batches, each added in order from no tokens and followed by steps until the net is quiet. */
function modelLog(net: Net, batches: readonly Batch[], policy: SelectionPolicy): string {
	let marking: Marking = {};
	const entries: unknown[] = [];
	for (const added of batches) {
		marking = withAdded(marking, added.tokens);
		entries.push(added);
		for (let step = fireStep(net, marking, policy); step.fired.length > 0; ) {
			marking = step.marking;
			entries.push(...step.fired);
			step = fireStep(net, marking, policy);
		}
	}
	return JSON.stringify(entries);
}

/** Batches of job tokens with fresh request ids, as a host sends them. The first gives the first tokens. */
const batchesArbitrary: fc.Arbitrary<readonly Batch[]> = fc
	.array(fc.array(fc.constantFrom("j1", "j2"), { minLength: 1, maxLength: 2 }), { minLength: 1, maxLength: 5 })
	.map((choices) => choices.map((tokens, index) => batch(`r${String(index)}`, tokens)));

/**
 * The first process enqueues the batches until it dies, before or after any of its commits lands. A second process
 * enqueues every batch again, from the first, with the same request ids, as a host does that cannot tell which
 * landed. At every commit the marking is the replay of the log and the net is quiet; the log is what the model gives,
 * so each batch landed once; and each enqueue of the second process returned the ingress that the log holds.
 */
export function crashProperty(factory: RuntimeFactory): fc.IAsyncProperty<[readonly Batch[], Fault, SelectionPolicy]> {
	return fc.asyncProperty(batchesArbitrary, faultArbitrary(8), policyArbitrary, async (batches, fault, policy) => {
		const clock = createClock();
		const runtime = factory(contestedOptions(policy, clock));
		const disk = createDisk([runtime.extension], clock);
		const enqueueAll = async (harness: Harness): Promise<Ingress[]> => {
			const instance = runtime.instance(harness, (await harness.root(context)).id);
			const acknowledged: Ingress[] = [];
			for (const sent of batches) {
				clock.moveTo(clock.now() + 1);
				acknowledged.push((await instance.enqueue(sent, context)).ingress);
			}
			return acknowledged;
		};
		await inProcess(disk, { [fault.kind]: fault.commit }, async ({ harness }) => {
			await enqueueAll(harness);
		});
		let acknowledged: readonly Ingress[] = [];
		const recovered = await inProcess(disk, {}, async ({ harness }) => {
			acknowledged = await enqueueAll(harness);
		});
		const { log } = lastState(disk.history());
		return (
			recovered === "done" &&
			everyCommitHeld(runtime.net, policy, disk.history()) &&
			untimed(log) === modelLog(runtime.net, batches, policy) &&
			JSON.stringify(acknowledged) === JSON.stringify(log.filter((entry) => entry.kind === "ingress"))
		);
	});
}

/** Two request ids, each always with the same tokens, so sending one twice is a duplicate delivery. */
const deliveries: readonly Batch[] = [batch("r0", ["j1"]), batch("r1", ["j2", "j1"])];

/** Each entry without its time, sorted, so two logs with the same entries in another order compare equal. */
function untimedSet(entries: readonly LogEntry[]): string {
	return JSON.stringify(entries.map((entry) => untimed([entry])).sort());
}

/**
 * The Session of an instance whose commits take effect only when the scheduler releases them, as over a remote
 * database, so a read can land between another enqueue's start and its commit.
 */
function scheduledHost(scheduler: fc.Scheduler, harness: Harness): NetInstanceHost {
	return {
		commit: (change, callContext) =>
			scheduler.schedule(Promise.resolve(), "commit").then(() => harness.commit(change, callContext)),
		snapshot: harness.snapshot.bind(harness),
		abortTask: harness.abortTask.bind(harness),
	};
}

/**
 * Up to four enqueues of the two deliveries, duplicates included, each started at a time the scheduler chooses, with
 * commits that the scheduler releases, so they run at once in any order. At every commit the marking is the replay
 * of the log and the net is quiet; each acknowledged ingress is in the log, and each request id is there once; and
 * the log's occurrences are what the enqueues returned as fired, together.
 */
export function raceProperty(
	factory: RuntimeFactory,
): fc.IAsyncProperty<[fc.Scheduler, readonly Batch[], SelectionPolicy]> {
	return fc.asyncProperty(
		fc.scheduler(),
		fc.array(fc.constantFrom(...deliveries), { minLength: 1, maxLength: 4 }),
		policyArbitrary,
		async (scheduler, sent, policy) => {
			const clock = createClock();
			const runtime = factory(contestedOptions(policy, clock));
			const disk = createDisk([runtime.extension], clock);
			let committed: readonly Committed[] = [];
			const outcome = await inProcess(disk, {}, async ({ harness }) => {
				const host = scheduledHost(scheduler, harness);
				const instance = runtime.instance(host, (await harness.root(context)).id);
				const enqueues = sent.map((delivery) =>
					scheduler
						.schedule(Promise.resolve(), delivery.requestId)
						.then(() => instance.enqueue(delivery, context)),
				);
				committed = await scheduler.waitFor(Promise.all(enqueues));
			});
			const distinctIds = new Set(sent.map((delivery) => delivery.requestId)).size;
			return (
				outcome === "done" &&
				everyCommitHeld(runtime.net, policy, disk.history()) &&
				raceHeld(disk.history(), committed, distinctIds)
			);
		},
	);
}

function raceHeld(history: readonly NetInstanceState[], committed: readonly Committed[], distinctIds: number): boolean {
	const { log } = lastState(history);
	const recorded = log.filter((entry) => entry.kind === "ingress").map((entry) => JSON.stringify(entry));
	return (
		committed.every(({ ingress }) => recorded.includes(JSON.stringify(ingress))) &&
		recorded.length === distinctIds &&
		untimedSet(committed.flatMap(({ fired }) => fired)) ===
			untimedSet(log.filter((entry) => entry.kind === "occurrence"))
	);
}
