import fc from "fast-check";
import type { ColourSet, Marking, Net, Place, Token } from "@petrus/petri-net";
import { definitionOrder, placeId, tokenKey } from "@petrus/petri-net";
import type {
	Batch,
	DelayedResult,
	Handler,
	HandlerResult,
	HandlerTransition,
	NetInstanceState,
	RuntimeOptions,
} from "../src/index.ts";
import { withHandlers } from "../src/index.ts";
import type { ResultArc } from "../src/index.ts";
import { operationsInFlight, startedOperations } from "../src/operations.ts";
import type { Disk, Faults, TestClock } from "./disk.ts";
import { context, createClock, createDisk, inProcess } from "./disk.ts";
import type { Fault, RuntimeFactory } from "./properties.ts";
import { everyCommitHeld, faultArbitrary, lastState } from "./properties.ts";
import { finished, queue, slots, work as jobsWork } from "./handler-properties.ts";

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

/** The plain net that the runtime runs, for replay. */
const plainWorkNet: Net = withHandlers(workNet, [work]);

/** The first batch: the jobs, and `slotCount` slots. */
export function jobsBatch(jobs: readonly string[], slotCount: number): Batch {
	return {
		requestId: "first",
		tokens: { [queue.id]: jobs, [slots.id]: Array.from({ length: slotCount }, () => "slot") },
	};
}

export function workOptions(handler: Handler, clock: TestClock): RuntimeOptions {
	return { name: "work", net: workNet, policy: definitionOrder, clock, handlers: [handler], retryDelayMs: 1 };
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
): Handler<"j" | "s"> & { readonly ran: () => readonly string[] } {
	const ran: string[] = [];
	return {
		transition: work,
		run: async ({ j }, { operationId, signal }) => {
			ran.push(operationId);
			await Promise.race([pause(), untilAborted(signal)]);
			const result: HandlerResult = { variant: "done", value: j };
			const delayMs = typeof j === "string" ? delays.get(j) : undefined;
			return delayMs === undefined ? result : ({ delayMs, result } satisfies DelayedResult);
		},
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
 * slots are back, nothing is in flight and no task is live; each operation has one result; and the operations that
 * ended `aborted` include each one whose abort returned `marked`, and only ones the host tried to abort.
 */
function abortsHeld(
	history: readonly NetInstanceState[],
	jobs: readonly string[],
	aborts: Aborts,
	liveTasks: number,
): boolean {
	const final = lastState(history);
	return (
		everyCommitHeld(plainWorkNet, definitionOrder, history) &&
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

/** Each operation whose abort returned `marked` ended `aborted`, and only an operation that the host tried to abort. */
function abortedAsCalled(final: NetInstanceState, aborts: Aborts): boolean {
	const aborted = abortedOperations(final);
	return [...aborts.marked].every((id) => aborted.has(id)) && [...aborted].every((id) => aborts.called.has(id));
}

const runArbitrary = fc.record({
	jobs: fc.shuffledSubarray(["j1", "j2", "j3"], { minLength: 1 }),
	delays: fc.dictionary(fc.constantFrom("j1", "j2", "j3"), fc.nat({ max: 20 })),
	aborted: fc.subarray(["j1", "j2", "j3"]),
});

type Run = { readonly jobs: string[]; readonly delays: Record<string, number>; readonly aborted: string[] };

/**
 * The host aborts the operations of some jobs at times the scheduler chooses, while work ends in any order, some of
 * it after a delay, and the first process dies before or after any of its commits lands. After a crash a new
 * process enqueues the jobs again and aborts the same jobs' operations that are still in flight. Then `abortsHeld`.
 */
export function abortFaultProperty(factory: RuntimeFactory): fc.IAsyncProperty<[fc.Scheduler, Run, Fault]> {
	return fc.asyncProperty(fc.scheduler(), runArbitrary, faultArbitrary(16), async (scheduler, run, fault) => {
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
				liveTasks = (await harness.inspect(context)).tasks.length;
			});
			if ((await scheduler.waitFor(body)) === "done") {
				break;
			}
			faults = {};
		}
		return abortsHeld(disk.history(), run.jobs, aborts, liveTasks);
	});
}
