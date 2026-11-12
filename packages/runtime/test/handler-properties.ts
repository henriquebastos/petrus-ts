import { randomUUID } from "node:crypto";
import { defineTask } from "@earendil-works/pi-durable";
import fc from "fast-check";
import type { ColourSet, Marking, Net, Place, Token } from "@petrus/petri-net";
import { definitionOrder, placeId, tokenKey, transitionId } from "@petrus/petri-net";
import type {
	Batch,
	Execution,
	ExecutionInput,
	HandlerResult,
	HandlerTransition,
	NetInstanceState,
	RuntimeOptions,
} from "../src/index.ts";
import { execution, withHandlers } from "../src/index.ts";
import { startedOperations } from "../src/operations.ts";
import type { Disk, TestClock } from "./disk.ts";
import { context, createClock, createDisk, enqueueAndSettle, inProcess } from "./disk.ts";
import type { Fault, RuntimeFactory } from "./properties.ts";
import { everyCommitHeld, faultArbitrary, lastState } from "./properties.ts";

const job: ColourSet = { name: "Job", contains: (token) => typeof token === "string" && /^j\d+$/.test(token) };
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

/** The host's first batch: the jobs, and the two slots. */
export function firstBatch(jobs: readonly string[]): Batch {
	return { requestId: "first", tokens: { [queue.id]: jobs, [slots.id]: ["slot", "slot"] } };
}

/** One more job, which the host sends while handlers run. */
const lateBatch: Batch = { requestId: "late", tokens: { [queue.id]: ["j4"] } };

const hostRequestIds = new Set([firstBatch([]).requestId, lateBatch.requestId]);

export function jobsOptions(service: Service, clock: TestClock): RuntimeOptions {
	return {
		name: "jobs",
		nonce: randomUUID(),
		net: jobsNet,
		policy: definitionOrder,
		clock,
		executions: [service.execution],
		startLimit: 100,
	};
}

/** The error of the service's one outage: the first run of job j2 fails. */
class Outage extends Error {
	override readonly name = "Outage";
}

/** The service outside the net, as the test sees it. */
export type Service = {
	readonly execution: Execution;
	/** How often the handler ran for each operation. */
	readonly calls: () => ReadonlyMap<string, number>;
	/** The job of each operation that the service did, by operation id. It does each one once (lookup-first). */
	readonly effects: () => ReadonlyMap<string, Token>;
	/** Handler runs that began before the occurrence that started them was committed. */
	readonly early: () => readonly string[];
	/** The most handlers that ran at once. */
	readonly mostAtOnce: () => number;
};

/**
 * A service that refuses job j3 and does every other job once: a second run of an operation finds the receipt of
 * the first. The first run of job j2 throws an `Outage`. `history` gives the committed states, so a run can tell
 * whether its operation was committed. `pause` is where a handler waits, so a scheduler can end handlers in any order.
 */
export function createService(
	history: () => readonly NetInstanceState[],
	pause: () => Promise<void> = () => Promise.resolve(),
): Service {
	const calls = new Map<string, number>();
	const effects = new Map<string, Token>();
	const receiptsByOperation = new Map<string, string>();
	const early: string[] = [];
	let running = 0;
	let mostAtOnce = 0;
	let outage = true;
	const run = async ({ binding, id: operationId }: ExecutionInput): Promise<HandlerResult> => {
		const committed = startedOperations(new Set([work.id]), lastState(history()).log);
		if (!committed.some(({ id, binding: b }) => id === operationId && tokenKey(b) === tokenKey(binding))) {
			early.push(operationId);
		}
		const count = (calls.get(operationId) ?? 0) + 1;
		calls.set(operationId, count);
		running += 1;
		mostAtOnce = Math.max(mostAtOnce, running);
		await pause();
		running -= 1;
		return answer(binding.j ?? null, operationId, count);
	};
	const native = defineTask<ExecutionInput, { readonly phase: "run" }, HandlerResult>({
		name: `jobs-test:${randomUUID()}`,
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async ({ input }, runtime, context) => {
				let result: HandlerResult;
				try {
					result = await run(input);
				} catch (error) {
					if (!(error instanceof Outage)) throw error;
					await runtime.sleepUntil(runtime.now() + 10, { phase: "run" }, context);
					return;
				}
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
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
		execution: execution(work, native),
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
 * `jobs` are all the jobs the host sent. At every commit the marking is the replay of the log and the net is quiet;
 * each job ran once in the net and ended; each started operation has one result, under its own request id; the
 * service did nothing for an operation that the log does not hold; and no handler ran before its occurrence was
 * committed.
 */
function handlersHeld(
	net: Net,
	history: readonly NetInstanceState[],
	service: Service,
	jobs: readonly string[],
): boolean {
	const final = lastState(history);
	return (
		everyCommitHeld(net, definitionOrder, history) &&
		sortedMarking(final.marking) === expectedMarking(jobs) &&
		operationsHeld(final, service, jobs.length)
	);
}

/** Each started operation has one result under its own request id, and the service did only committed operations. */
function operationsHeld(final: NetInstanceState, service: Service, jobCount: number): boolean {
	const started = startedOperations(new Set([work.id]), final.log);
	const results = final.log.flatMap((entry) =>
		entry.kind === "ingress" && !hostRequestIds.has(entry.requestId) ? [entry.requestId] : [],
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

/**
 * The first process dies before or after any of its commits lands, and the service has its outage. Each process
 * enqueues the first batch, which adds nothing after a crash, and settles; after a crash a new process does the same.
 * Then every handler property holds (see `handlersHeld`): work in flight at the crash runs again and ends once.
 */
export function handlerFaultProperty(factory: RuntimeFactory): fc.IAsyncProperty<[readonly string[], Fault]> {
	return fc.asyncProperty(jobsArbitrary, faultArbitrary(64), async (jobs, fault) => {
		const clock = createClock();
		const service = createService(() => disk.history());
		const runtime = factory(jobsOptions(service, clock));
		const disk: Disk = createDisk([runtime.extension], clock);
		await enqueueAndSettle(disk, { [fault.kind]: fault.commit }, runtime, firstBatch(jobs));
		return handlersHeld(runtime.net, disk.history(), service, jobs);
	});
}

/** The race property's checks, after the last settle. */
function raceHeld(net: Net, disk: Disk, service: Service, jobs: readonly string[]): boolean {
	return (
		handlersHeld(net, disk.history(), service, [...jobs, "j4"]) &&
		disk.reports().length === 0 &&
		ranOnceEach(lastState(disk.history()), service) &&
		service.mostAtOnce() <= 2
	);
}

/** Each operation's handler ran once, and the operation of job j2 twice: the outage, then the run that ended it. */
function ranOnceEach(final: NetInstanceState, service: Service): boolean {
	const jobOf = new Map(startedOperations(new Set([work.id]), final.log).map(({ id, binding }) => [id, binding.j]));
	return [...service.calls()].every(([id, count]) => count === (jobOf.get(id) === "j2" ? 2 : 1));
}

/**
 * The scheduler ends each handler run, and the host sends a late batch of one more job at a time the scheduler
 * chooses, while workers run. The native task catches the outage and retries after its explicit Durable sleep.
 * After a last settle every handler property holds (see `handlersHeld`), each operation's handler ran once (twice
 * for the outage), and the two slots kept at most two handlers running at once.
 */
export function handlerRaceProperty(factory: RuntimeFactory): fc.IAsyncProperty<[fc.Scheduler, readonly string[]]> {
	return fc.asyncProperty(
		fc.scheduler(),
		fc.shuffledSubarray(["j1", "j2", "j3"], { minLength: 1 }),
		async (scheduler, jobs) => {
			const clock = createClock();
			const service = createService(
				() => disk.history(),
				() => scheduler.schedule(Promise.resolve(), "handler"),
			);
			const runtime = factory(jobsOptions(service, clock));
			const disk: Disk = createDisk([runtime.extension], clock);
			const outcome = await inProcess(disk, {}, async ({ harness, settle }) => {
				const instance = runtime.instance(harness, (await harness.root(context)).id);
				await instance.enqueue(firstBatch(jobs), context);
				const late = scheduler.schedule(Promise.resolve(), "late").then(() => instance.enqueue(lateBatch, context));
				await scheduler.waitFor(Promise.all([settle(), late]));
				await scheduler.waitFor(settle());
			});
			return outcome === "done" && raceHeld(runtime.net, disk, service, jobs);
		},
	);
}
