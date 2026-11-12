import { randomUUID } from "node:crypto";
import { defineTask } from "@earendil-works/pi-durable";
import fc from "fast-check";
import type { ColourSet, Net, Place, Token } from "@petrus/petri-net";
import { definitionOrder, placeId, tokenKey, tokensAt, transitionId } from "@petrus/petri-net";
import type {
	Execution,
	ExecutionInput,
	HandlerResult,
	HandlerTransition,
	NetInstanceState,
	RuntimeOptions,
} from "../src/index.ts";
import { execution } from "../src/index.ts";
import { startedOperations } from "../src/operations.ts";
import type { Disk, TestClock } from "./disk.ts";
import { createClock, createDisk, enqueueAndSettle } from "./disk.ts";
import type { Fault, RuntimeFactory } from "./properties.ts";
import { everyCommitHeld, faultArbitrary, lastState } from "./properties.ts";
import { completeSaved } from "./native-execution.ts";

const reminder: ColourSet = { name: "Reminder", contains: (token) => typeof token === "string" && /^r\d$/.test(token) };

export const requested: Place = { id: placeId("requested"), colourSet: reminder };
export const reminded: Place = { id: placeId("reminded"), colourSet: reminder };

/** A reminder waits on `requested` until its handler's delay ends, and then it is on `reminded`. */
export function remindTransition(
	output: (value: Token) => readonly Token[] = (value) => [value],
): HandlerTransition<"r"> {
	return {
		id: transitionId("remind"),
		variables: { r: reminder },
		guard: () => true,
		inputs: [{ place: requested, variables: ["r"] }],
		variants: {
			elapsed: { value: reminder, outputs: [{ place: reminded, expression: (_binding, value) => output(value) }] },
		},
	};
}

/** The net without its handler transition. The runtime adds it from the handler. */
const remindersNet: Net = { places: [requested, reminded], transitions: [] };

type ReminderSchedule = { readonly delayMs: number; readonly result: HandlerResult };
type Checkpoint = { readonly phase: "run" } | { readonly phase: "due"; readonly result: HandlerResult };

/** A handler of `transition` whose answer for each run comes from `answer`, given the reminder and the run's number. */
export function reminderHandler(
	answer: (r: Token, run: number) => ReminderSchedule,
	transition: HandlerTransition<"r"> = remindTransition(),
): Execution & { readonly runs: () => number } {
	let runs = 0;
	const task = defineTask<ExecutionInput, Checkpoint, HandlerResult>({
		name: `reminder-test:${randomUUID()}`,
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async ({ input }, runtime, context) => {
				runs += 1;
				const { delayMs, result } = answer(input.binding.r ?? null, runs);
				if (!Number.isFinite(delayMs) || delayMs < 0) {
					throw new RangeError(
						`a delay must be a finite number of milliseconds, at least 0, not ${String(delayMs)}`,
					);
				}
				await runtime.sleepUntil(input.startedAt + delayMs, { phase: "due", result }, context);
			},
			due: completeSaved,
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
	return {
		...execution(transition, task),
		runs: () => runs,
	};
}

/** A delay of `delayMs` for the result `elapsed` of reminder `r`. */
export function elapsedAfter(r: Token, delayMs: number): ReminderSchedule {
	return { delayMs, result: { variant: "elapsed", value: r } };
}

export function remindersOptions(handler: Execution, clock: TestClock): RuntimeOptions {
	return {
		name: "reminders",
		nonce: randomUUID(),
		net: remindersNet,
		policy: definitionOrder,
		clock,
		executions: [handler],
		startLimit: 100,
	};
}

/**
 * Each result is in the log at its due time, the start of its operation plus the delay of its reminder. After an
 * outage a result already due counts at once: at the time that the next process opened.
 */
function resultsOnTime(
	final: NetInstanceState,
	delays: ReadonlyMap<string, number>,
	opened: readonly number[],
): boolean {
	const started = startedOperations(new Set([remindTransition().id]), final.log);
	return started.every((operation) => {
		const startedAt = final.log[Number(operation.id.split("/")[1])]?.at ?? Number.NaN;
		const recorded = final.log.find(
			(entry) => entry.kind === "ingress" && entry.requestId === `result:${operation.id}`,
		);
		return countedOnTime(recorded?.at, startedAt + delayOf(delays, operation.binding.r ?? null), opened);
	});
}

/** A result at `at` is on time when it is at its due time, or later at the time that a process opened. */
function countedOnTime(at: number | undefined, due: number, opened: readonly number[]): boolean {
	return at === due || (at !== undefined && at > due && opened.includes(at));
}

/**
 * At every commit the marking is the replay of the log and the net is quiet. At the end every reminder is on
 * `reminded` once, and each result is in the log at its due time (see `resultsOnTime`): not before, and not later.
 */
function delaysHeld(
	net: Net,
	history: readonly NetInstanceState[],
	delays: ReadonlyMap<string, number>,
	opened: readonly number[],
): boolean {
	const final = lastState(history);
	const sorted = (place: Place): string => JSON.stringify(tokensAt(final.marking, place.id).map(tokenKey).sort());
	return (
		everyCommitHeld(net, definitionOrder, history) &&
		sorted(reminded) === JSON.stringify([...delays.keys()].map(tokenKey).sort()) &&
		sorted(requested) === "[]" &&
		resultsOnTime(final, delays, opened)
	);
}

const delaysArbitrary: fc.Arbitrary<ReadonlyMap<string, number>> = fc
	.uniqueArray(fc.tuple(fc.constantFrom("r1", "r2", "r3"), fc.nat({ max: 50 })), {
		minLength: 1,
		selector: ([r]) => r,
	})
	.map((entries) => new Map(entries));

/** The delay that `delays` gives reminder `r`, or `NaN` for a token that is no reminder there. */
function delayOf(delays: ReadonlyMap<string, number>, r: Token): number {
	return typeof r === "string" ? (delays.get(r) ?? Number.NaN) : Number.NaN;
}

/**
 * The first process dies before or after any of its commits lands. Each process enqueues the reminders, which adds
 * nothing after a crash, and settles, which moves the clock to each sleep's end; after a crash and an outage of
 * `outageMs` a new process does the same. Then `delaysHeld`: a wait that a crash cut keeps its end, since it counts
 * from the start of its operation, and a wait that the outage passed ends at once.
 */
export function delayFaultProperty(
	factory: RuntimeFactory,
): fc.IAsyncProperty<[ReadonlyMap<string, number>, Fault, number]> {
	return fc.asyncProperty(
		delaysArbitrary,
		faultArbitrary(48),
		fc.nat({ max: 60 }),
		async (delays, fault, outageMs) => {
			const clock = createClock(100);
			const handler = reminderHandler((r) => elapsedAfter(r, delayOf(delays, r)));
			const runtime = factory(remindersOptions(handler, clock));
			const disk: Disk = createDisk([runtime.extension], clock);
			const reminders = { requestId: "first", tokens: { [requested.id]: [...delays.keys()] } };
			const opened = await enqueueAndSettle(disk, { [fault.kind]: fault.commit }, runtime, reminders, outageMs);
			return delaysHeld(runtime.net, disk.history(), delays, opened);
		},
	);
}
