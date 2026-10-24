import fc from "fast-check";
import type { ColourSet, Marking, Net, Place, Token } from "@petrus/petri-net";
import { definitionOrder, placeId, tokenKey, transitionId } from "@petrus/petri-net";
import type {
	Handler,
	HandlerResult,
	HandlerTransition,
	NetInstanceState,
	Runtime,
	RuntimeOptions,
} from "../src/index.ts";
import { withHandlers } from "../src/index.ts";
import { startedOperations } from "../src/operations.ts";
import type { Disk } from "./controlled-store.ts";
import { CommitFailed, createDisk, ReplyLost, scheduledStore, StoreCrashed } from "./controlled-store.ts";
import type { RuntimeFactory } from "./properties.ts";
import { replay, sameMarking } from "./replay.ts";

const job: ColourSet = { name: "Job", contains: (token) => typeof token === "string" && /^j\d$/.test(token) };
const slot: ColourSet = { name: "Slot", contains: (token) => token === "slot" };
const receipt: ColourSet = {
	name: "Receipt",
	contains: (token) => typeof token === "string" && token.startsWith("receipt "),
};
const reason: ColourSet = { name: "Reason", contains: (token) => token === "refused" };

export const queue: Place = { id: placeId("queue"), colourSet: job };
export const slots: Place = { id: placeId("slots"), colourSet: slot };
export const finished: Place = { id: placeId("finished"), colourSet: job };
export const receipts: Place = { id: placeId("receipts"), colourSet: receipt };
export const refused: Place = { id: placeId("refused"), colourSet: job };

/**
 * Work on one job takes the job and a slot. The outside service ends it as `done` with a receipt, or as `refused`;
 * either way the slot comes back, so two slots let at most two handlers run at once.
 */
export const work: HandlerTransition<"j" | "s"> = {
	id: transitionId("work"),
	variables: { j: job, s: slot },
	guard: () => true,
	inputs: [
		{ place: queue, variables: ["j"] },
		{ place: slots, variables: ["s"] },
	],
	variants: {
		done: {
			value: receipt,
			outputs: [
				{ place: finished, expression: ({ j }) => [j] },
				{ place: slots, expression: ({ s }) => [s] },
				{ place: receipts, expression: (_binding, value) => [value] },
			],
		},
		refused: {
			value: reason,
			outputs: [
				{ place: refused, expression: ({ j }) => [j] },
				{ place: slots, expression: ({ s }) => [s] },
			],
		},
	},
};

/** The net without its handler transition. The runtime adds it from the handler. */
export const jobsNet: Net = { places: [queue, slots, finished, receipts, refused], transitions: [] };

/** The plain net that the runtime runs, for replay. */
export const plainJobsNet: Net = withHandlers(jobsNet, [work]);

export function jobsState(jobs: readonly string[]): NetInstanceState {
	return { marking: { [queue.id]: jobs, [slots.id]: ["slot", "slot"] }, log: [] };
}

/** The error of the service's one outage: the first run of job j2 fails. */
class Outage extends Error {
	override readonly name = "Outage";
}

/** The service outside the net, as the test sees it. */
export type Service = {
	readonly handler: Handler;
	/** How often the handler ran for each operation. */
	readonly calls: () => ReadonlyMap<string, number>;
	/** The job of each operation that the service did, by operation id. It does each one once (lookup-first). */
	readonly effects: () => ReadonlyMap<string, Token>;
	/** Handler runs that began before the occurrence that started them was stored. */
	readonly early: () => readonly string[];
	/** The most handlers that ran at once. */
	readonly mostAtOnce: () => number;
};

/**
 * A service that refuses job j3 and does every other job once: a second run of an operation finds the receipt of
 * the first. The first run of job j2 throws an `Outage`. `pause` is where a handler waits, so a scheduler can end
 * handlers in any order.
 */
export function createService(disk: Disk, pause: () => Promise<void> = () => Promise.resolve()): Service {
	const calls = new Map<string, number>();
	const effects = new Map<string, Token>();
	const receiptsByOperation = new Map<string, string>();
	const early: string[] = [];
	let running = 0;
	let mostAtOnce = 0;
	let outage = true;
	const handler: Handler<"j" | "s"> = {
		transition: work,
		run: async (binding, { operationId }) => {
			const stored = startedOperations(new Set([work.id]), disk.stored().log);
			if (!stored.some(({ id, binding: b }) => id === operationId && tokenKey(b) === tokenKey(binding))) {
				early.push(operationId);
			}
			const count = (calls.get(operationId) ?? 0) + 1;
			calls.set(operationId, count);
			running += 1;
			mostAtOnce = Math.max(mostAtOnce, running);
			await pause();
			running -= 1;
			return answer(binding.j, operationId, count);
		},
	};
	/** The service's answer: the outage once for j2, a refusal for j3, else the receipt of the operation's first run. */
	function answer(j: Token, operationId: string, count: number): HandlerResult {
		if (j === "j2" && outage) {
			outage = false;
			throw new Outage("the service is down");
		}
		if (j === "j3") {
			return { variant: "refused", value: "refused" };
		}
		effects.set(operationId, j);
		const first = receiptsByOperation.get(operationId) ?? `receipt ${tokenKey(j)} run ${String(count)}`;
		receiptsByOperation.set(operationId, first);
		return { variant: "done", value: first };
	}
	return {
		handler,
		calls: () => calls,
		effects: () => effects,
		early: () => early,
		mostAtOnce: () => mostAtOnce,
	};
}

/** The marking after all jobs: every job finished or refused, both slots back, nothing busy and no result waiting. */
function expectedMarking(jobs: readonly string[]): string {
	const done = jobs.filter((j) => j !== "j3");
	return sortedMarking({
		[slots.id]: ["slot", "slot"],
		...(done.length > 0 ? { [finished.id]: done, [receipts.id]: done.map(() => "receipt") } : {}),
		...(jobs.includes("j3") ? { [refused.id]: ["j3"] } : {}),
	});
}

/** The marking as text with each token list sorted, and each receipt as the word `receipt`, since its run varies. */
function sortedMarking(marking: Marking): string {
	return JSON.stringify(
		Object.entries(marking)
			.map(([place, tokens]) => [
				place,
				(place === receipts.id ? tokens.map(() => "receipt") : tokens).map(tokenKey).sort(),
			])
			.sort(([a], [b]) => String(a).localeCompare(String(b))),
	);
}

/**
 * `first` are the jobs at the start and `jobs` all the jobs, with the batch under the request id `late`.
 * The stored state is the replay of its log; each job ran once in the net and ended; each started operation has
 * one result, under its own request id; the service did nothing for an operation that the store does not hold;
 * and no handler ran before its occurrence was stored.
 */
function handlersHeld(disk: Disk, service: Service, first: readonly string[], jobs: readonly string[]): boolean {
	const stored = disk.stored();
	return (
		sameMarking(replay(plainJobsNet, jobsState(first).marking, stored.log), stored.marking) &&
		sortedMarking(stored.marking) === expectedMarking(jobs) &&
		operationsHeld(stored, service, jobs.length)
	);
}

/** Each started operation has one result under its own request id, and the service did only stored operations. */
function operationsHeld(stored: NetInstanceState, service: Service, jobCount: number): boolean {
	const started = startedOperations(new Set([work.id]), stored.log);
	const results = stored.log.flatMap((entry) =>
		entry.kind === "ingress" && entry.requestId !== "late" ? [entry.requestId] : [],
	);
	const jobOf = new Map(started.map((operation) => [operation.id, operation.binding.j]));
	return (
		started.length === jobCount &&
		JSON.stringify(results.sort()) === JSON.stringify(started.map(({ id }) => `result:${id}`).sort()) &&
		[...service.effects()].every(([id, j]) => jobOf.get(id) === j) &&
		service.early().length === 0
	);
}

const jobsArbitrary: fc.Arbitrary<readonly string[]> = fc.shuffledSubarray(["j1", "j2", "j3", "j4"], {
	minLength: 1,
});

/** One store fault: a crash before or after a commit lands, a lost reply, or a commit that fails. */
type Fault = {
	readonly commit: number;
	readonly kind: "crashAtCommit" | "crashAfterCommit" | "loseReplyAtCommit" | "failAtCommit";
};

const faultArbitrary: fc.Arbitrary<Fault> = fc.record({
	commit: fc.nat({ max: 12 }),
	kind: fc.constantFrom("crashAtCommit", "crashAfterCommit", "loseReplyAtCommit", "failAtCommit"),
});

/**
 * One store fault at any commit of a settle, and the service's outage. After a crash the host opens a new runtime
 * over the same disk; after a lost reply, a failed commit or the outage it calls settle again. Then every handler property holds (see `handlersHeld`):
 * work in flight at the crash runs again and ends once.
 */
export function handlerFaultProperty(factory: RuntimeFactory): fc.IAsyncProperty<[readonly string[], Fault]> {
	return fc.asyncProperty(jobsArbitrary, faultArbitrary, async (jobs, fault) => {
		const disk = createDisk(jobsState(jobs));
		const service = createService(disk);
		const open = (faults: Partial<Record<Fault["kind"], number>>): Runtime =>
			factory({ ...jobsOptions(service), store: disk.open(faults) });
		let runtime = open({ [fault.kind]: fault.commit });
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const outcome = await settled(runtime);
			if (outcome === "done") {
				break;
			}
			runtime = outcome === "crashed" ? open({}) : runtime;
		}
		return handlersHeld(disk, service, jobs, jobs);
	});
}

/** The race property's checks, after the last settle. `rejected` are the reasons of the settles that rejected. */
function raceHeld(disk: Disk, service: Service, jobs: readonly string[], rejected: readonly unknown[]): boolean {
	return (
		handlersHeld(disk, service, jobs, [...jobs, "j4"]) &&
		outageReportedOnce(jobs, rejected) &&
		ranOnceEach(disk, service) &&
		service.mostAtOnce() <= 2
	);
}

/** One settle rejected, with the outage, when job j2 ran; none otherwise. */
function outageReportedOnce(jobs: readonly string[], rejected: readonly unknown[]): boolean {
	const expected = jobs.includes("j2") ? 1 : 0;
	return rejected.length === expected && rejected.every((reason) => reason instanceof Outage);
}

/** Each operation's handler ran once, and the operation of job j2 twice: the outage, then the run that ended it. */
function ranOnceEach(disk: Disk, service: Service): boolean {
	const jobOf = new Map(
		startedOperations(new Set([work.id]), disk.stored().log).map(({ id, binding }) => [id, binding.j]),
	);
	return [...service.calls()].every(([id, count]) => count === (jobOf.get(id) === "j2" ? 2 : 1));
}

function jobsOptions(service: Service): Omit<RuntimeOptions, "store"> {
	return { net: jobsNet, policy: definitionOrder, clock: { now: () => 0 }, handlers: [service.handler] };
}

/** Settles once. A store fault or the outage is the fault under test; any other error is a real failure. */
async function settled(runtime: Runtime): Promise<"done" | "crashed" | "failed"> {
	try {
		await runtime.settle();
		return "done";
	} catch (error: unknown) {
		return faultKind(error);
	}
}

function faultKind(error: unknown): "crashed" | "failed" {
	if (error instanceof StoreCrashed) {
		return "crashed";
	}
	if (error instanceof ReplyLost || error instanceof CommitFailed || error instanceof Outage) {
		return "failed";
	}
	throw error;
}

/**
 * Up to three settles that start at any time and run at once, and a late batch of one more job, while the store
 * and the handlers answer in any order. The outage makes exactly one settle reject, and a later round runs that
 * operation again. After a last settle every handler property holds (see `handlersHeld`), each operation's handler
 * ran once (twice for the outage), and the two slots kept at most two handlers running at once.
 */
export function handlerRaceProperty(
	factory: RuntimeFactory,
): fc.IAsyncProperty<[fc.Scheduler, readonly string[], number]> {
	return fc.asyncProperty(
		fc.scheduler(),
		fc.shuffledSubarray(["j1", "j2", "j3"], { minLength: 1 }),
		fc.integer({ min: 1, max: 3 }),
		async (scheduler, jobs, settles) => {
			const disk = createDisk(jobsState(jobs));
			const service = createService(disk, () => scheduler.schedule(Promise.resolve(), "handler"));
			const runtime = factory({ ...jobsOptions(service), store: scheduledStore(scheduler, disk.open()) });
			const late = runtime.enqueue({ requestId: "late", tokens: { [queue.id]: ["j4"] } });
			const calls = Array.from({ length: settles }, () =>
				scheduler.schedule(Promise.resolve(), "settle").then(runtime.settle),
			);
			const [, ...outcomes] = await scheduler.waitFor(Promise.allSettled([late, ...calls]));
			await scheduler.waitFor(runtime.settle());
			const rejected = outcomes.flatMap((outcome): readonly unknown[] =>
				outcome.status === "rejected" ? [outcome.reason] : [],
			);
			return raceHeld(disk, service, jobs, rejected);
		},
	);
}
