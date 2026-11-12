import { randomUUID } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import type { Harness, JsonObject, TaskRecord } from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import fc from "fast-check";
import type { ColourSet, Marking, Net, Place, Token } from "@petrus/petri-net";
import { definitionOrder, placeId, tokenKey } from "@petrus/petri-net";
import type {
	Batch,
	Execution,
	ExecutionInput,
	HandlerResult,
	HandlerTransition,
	NetInstance,
	NetInstanceState,
	RuntimeOptions,
} from "../src/index.ts";
import { execution } from "../src/index.ts";
import type { ResultArc } from "../src/index.ts";
import { operationsInFlight, startedOperations } from "../src/operations.ts";
import type { Disk, Faults, TestClock } from "./disk.ts";
import { context, createClock, createDisk, inProcess } from "./disk.ts";
import type { Fault, RuntimeFactory } from "./properties.ts";
import { everyCommitHeld, faultArbitrary, lastState } from "./properties.ts";
import { finished, queue, slots, work as jobsWork } from "./handler-properties.ts";
import { completed, completeSaved } from "./native-execution.ts";

const finishedArc: ResultArc<"j" | "s"> = { place: finished, expression: ({ j }) => [j] };
const slotBack: ResultArc<"j" | "s"> = { place: slots, expression: ({ s }) => [s] };

const unit: ColourSet = { name: "Unit", contains: (token) => token === null };

export const cancelled: Place = { id: placeId("cancelled"), colourSet: queue.colourSet };

/**
 * The jobs net's work, which holds a slot, with other ends: `done`, or `aborted` when the host aborts it. Either way
 * the slot comes back.
 */
export const work: HandlerTransition<"j" | "s"> = {
	...jobsWork,
	variants: {
		done: { value: queue.colourSet, outputs: [finishedArc, slotBack] },
		aborted: { value: unit, outputs: [{ place: cancelled, expression: ({ j }) => [j] }, slotBack] },
	},
};

const workNet: Net = { places: [queue, slots, finished, cancelled], transitions: [] };

/** The first batch: the jobs, and `slotCount` slots. */
export function jobsBatch(jobs: readonly string[], slotCount: number): Batch {
	return {
		requestId: "first",
		tokens: { [queue.id]: jobs, [slots.id]: Array.from({ length: slotCount }, () => "slot") },
	};
}

export function workOptions(handler: Execution, clock: TestClock): RuntimeOptions {
	return {
		name: "work",
		nonce: randomUUID(),
		net: workNet,
		policy: definitionOrder,
		clock,
		executions: [handler],
		startLimit: 200,
	};
}

/** A promise that rejects once the signal aborts, with the signal's reason as the cause. */
export function untilAborted(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		const abort = (): void => {
			reject(new Error("the work was aborted", { cause: signal.reason }));
		};
		if (signal.aborted) {
			abort();
		}
		signal.addEventListener("abort", abort, { once: true });
	});
}

/**
 * A handler of `work` that waits for `pause` or its signal, then ends `done`, after `delays` milliseconds when it
 * names the job. `ran` lists the operations of its runs.
 */
export function workHandler(
	pause: () => Promise<void>,
	delays: ReadonlyMap<string, number> = new Map(),
): Execution & { readonly ran: () => readonly string[] } {
	const ran: string[] = [];
	type Checkpoint = { readonly phase: "run" } | { readonly phase: "due"; readonly result: HandlerResult };
	const task = defineTask<ExecutionInput, Checkpoint, HandlerResult>({
		name: `abort-test:${randomUUID()}`,
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async ({ input }, runtime, context) => {
				ran.push(input.id);
				await Promise.race([pause(), untilAborted(runtime.signal)]);
				const j = input.binding.j ?? null;
				const result: HandlerResult = { variant: "done", value: j };
				const delayMs = typeof j === "string" ? delays.get(j) : undefined;
				if (delayMs !== undefined) {
					await runtime.sleepUntil(input.startedAt + delayMs, { phase: "due", result }, context);
				} else {
					await runtime.commit(() => completed(result), context);
				}
			},
			due: completeSaved,
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => completed({ variant: "aborted", value: null }), context);
		},
	});
	return {
		...execution(work, task),
		ran: () => ran,
	};
}

/** The ids of the operations whose result is `aborted`, from the log. */
export function abortedOperations(final: NetInstanceState): ReadonlySet<string> {
	return new Set(
		final.log.flatMap((entry) =>
			entry.kind === "ingress" && entry.requestId.startsWith("result:") && aborts(entry.tokens)
				? [entry.requestId.slice("result:".length)]
				: [],
		),
	);
}

function aborts(tokens: Marking): boolean {
	return Object.values(tokens)
		.flat()
		.some(
			(token) => typeof token === "object" && token !== null && "variant" in token && token.variant === "aborted",
		);
}

/** The abort calls of a run: the operations that the host tried to abort, and those whose abort returned `marked`. */
type Aborts = { readonly called: Set<string>; readonly marked: Set<string> };

/** The marking as text, each token list sorted, with the ended jobs as `ended` whichever way they ended. */
function endMarking(marking: Marking): string {
	const ended: readonly Token[] = [...(marking[finished.id] ?? []), ...(marking[cancelled.id] ?? [])];
	const rest = Object.entries(marking).filter(([place]) => place !== finished.id && place !== cancelled.id);
	return JSON.stringify(
		[["ended", ended] as const, ...rest]
			.filter(([, tokens]) => tokens.length > 0)
			.map(([place, tokens]) => [place, tokens.map(tokenKey).sort()])
			.sort(),
	);
}

/**
 * At every commit the marking is the replay of the log and the net is quiet. At the end every job ended once, both
 * slots are back, nothing is in flight and no task is live. Each operation has one result.
 * Only operations that the host tried to cancel end with an aborted result.
 */
function abortsHeld(
	net: Net,
	history: readonly NetInstanceState[],
	jobs: readonly string[],
	aborts: Aborts,
	liveTasks: number,
): boolean {
	const final = lastState(history);
	return (
		everyCommitHeld(net, definitionOrder, history) &&
		endMarking(final.marking) === endMarking({ [finished.id]: jobs, [slots.id]: ["slot", "slot"] }) &&
		allEnded(final, liveTasks) &&
		abortedAsCalled(final, aborts)
	);
}

/** Nothing is in flight, no task is live, and each started operation has one result. */
function allEnded(final: NetInstanceState, liveTasks: number): boolean {
	const results = final.log.filter((entry) => entry.kind === "ingress" && entry.requestId.startsWith("result:"));
	return (
		operationsInFlight(new Set([work.id]), final.log).length === 0 &&
		liveTasks === 0 &&
		results.length === startedOperations(new Set([work.id]), final.log).length
	);
}

/** Only operations that the host tried to cancel have an aborted result. A marked abort can preserve success. */
function abortedAsCalled(final: NetInstanceState, aborts: Aborts): boolean {
	const aborted = abortedOperations(final);
	return [...aborted].every((id) => aborts.called.has(id));
}

const runArbitrary = fc.record({
	jobs: fc.shuffledSubarray(["j1", "j2", "j3"], { minLength: 1 }),
	delays: fc.dictionary(fc.constantFrom("j1", "j2", "j3"), fc.nat({ max: 20 })),
	aborted: fc.subarray(["j1", "j2", "j3"]),
});

type Run = { readonly jobs: string[]; readonly delays: Record<string, number>; readonly aborted: string[] };

function objectValue(value: JsonValue | undefined): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("the native task did not store an object");
	}
	return value;
}

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

function nativeResult(worker: StoredTask): JsonObject {
	const { state } = worker;
	if (state.status !== "terminal" || state.outcome.status !== "completed") {
		throw new Error("the native worker did not choose a result");
	}
	return objectValue(state.outcome.result);
}

function nativeResultHeld(worker: StoredTask, state: NetInstanceState): boolean {
	const input = objectValue(worker.input);
	const id = input.id;
	if (typeof id !== "string") throw new Error("the worker has no operation id");
	const result = nativeResult(worker);
	const ingress = state.log.find((entry) => entry.kind === "ingress" && entry.requestId === `result:${id}`);
	return (
		ingress?.kind === "ingress" &&
		Object.values(ingress.tokens)
			.flat()
			.some((token) => tokenKey(token) === tokenKey({ binding: input.binding ?? null, ...result }))
	);
}

async function verifyNativeResults(harness: Harness, instance: NetInstance): Promise<void> {
	const conversationId = (await harness.root(context)).id;
	const records = await harness.commit((tx) => tx.scanTasks({ conversationId }, 100), context);
	if (records.next !== undefined) throw new Error("the finite workload exceeded one page of tasks");
	const workers = records.items.filter(({ kind }) => kind.startsWith("abort-test:"));
	const state = await instance.state(context);
	if (!workers.every((worker) => nativeResultHeld(worker, state))) {
		throw new Error("settlement lost or replaced the native worker's result");
	}
}

/** Every case cancels after the worker sleeps, before its deadline, and checks the retained native result. */
export function sleepingAbortProperty(factory: RuntimeFactory): fc.IAsyncProperty<[number]> {
	return fc.asyncProperty(fc.integer({ min: 1, max: 20 }), async (delay) => {
		const clock = createClock();
		const worker = workHandler(() => Promise.resolve(), new Map([["j1", delay]]));
		const runtime = factory(workOptions(worker, clock));
		const disk = createDisk([runtime.extension], clock);
		await inProcess(disk, {}, async ({ harness, runReady, settle }) => {
			const instance = runtime.instance(harness, (await harness.root(context)).id);
			await instance.enqueue(jobsBatch(["j1"], 1), context);
			await runReady();
			const records = await harness.commit((tx) => tx.scanTasks({}, 100), context);
			if (!records.items.some((task) => task.state.status === "sleeping")) {
				throw new Error("the worker must sleep before cancellation");
			}
			await instance.abort("work/1", context);
			await settle();
			await verifyNativeResults(harness, instance);
		});
	});
}

/**
 * The host aborts the operations of some jobs at times the scheduler chooses, while work ends in any order, some of
 * it after a delay, and the first process dies before or after any of its commits lands. After a crash a new
 * process enqueues the jobs again and aborts the same jobs' operations that are still in flight. Then `abortsHeld`.
 */
export function abortFaultProperty(factory: RuntimeFactory): fc.IAsyncProperty<[fc.Scheduler, Run, Fault]> {
	return fc.asyncProperty(fc.scheduler(), runArbitrary, faultArbitrary(64), async (scheduler, run, fault) => {
		const clock = createClock();
		const handler = workHandler(
			() => scheduler.schedule(Promise.resolve(), "work"),
			new Map(Object.entries(run.delays)),
		);
		const runtime = factory(workOptions(handler, clock));
		const disk: Disk = createDisk([runtime.extension], clock);
		const aborts: Aborts = { called: new Set(), marked: new Set() };
		let liveTasks = Number.NaN;
		let faults: Faults = { [fault.kind]: fault.commit };
		for (let processes = 0; processes < 4; processes += 1) {
			const body = inProcess(disk, faults, async ({ harness, settle }) => {
				const instance = runtime.instance(harness, (await harness.root(context)).id);
				await instance.enqueue(jobsBatch(run.jobs, 2), context);
				const abortInFlight = async (): Promise<void> => {
					const calls = (await instance.inFlight(context))
						.filter(
							({ id, binding: { j } }) =>
								typeof j === "string" && run.aborted.includes(j) && !aborts.marked.has(id),
						)
						.map(async (operation) => {
							await scheduler.schedule(Promise.resolve(), "abort");
							aborts.called.add(operation.id);
							if ((await instance.abort(operation.id, context)) === "marked") {
								aborts.marked.add(operation.id);
							}
						});
					// After a crash a call can end on the closed Harness; in a run that lives, `Promise.all` still sees it.
					for (const call of calls) {
						call.catch(() => undefined);
					}
					await settle();
					await Promise.all(calls);
				};
				// The second round aborts the operations that started after the first, as j3 once a slot came back.
				await abortInFlight();
				await abortInFlight();
				await settle();
				await verifyNativeResults(harness, instance);
				for (const operation of await instance.inFlight(context)) {
					if (!aborts.called.has(operation.id)) throw new Error("an unrequested operation lost its result");
					await instance.resolve(operation.id, { variant: "aborted", value: null }, context);
				}
				await settle();
				liveTasks = (await harness.inspect(context)).tasks.length;
			});
			if ((await scheduler.waitFor(body)) === "done") {
				break;
			}
			faults = {};
		}
		return abortsHeld(runtime.net, disk.history(), run.jobs, aborts, liveTasks);
	});
}
