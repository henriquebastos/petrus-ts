import type { ConversationId, Harness, TaskInspection } from "@earendil-works/pi-durable";
import type { Net, Transition } from "@petrus/petri-net";
import { transitionId } from "@petrus/petri-net";
import type { Operation, Runtime } from "../src/index.ts";
import type { NetInstanceRecord } from "../src/net-instance-record.ts";
import { netInstanceRecord } from "../src/net-instance-record.ts";
import { operationsInFlight } from "../src/operations.ts";
import { context, createClock, createDisk } from "./disk.ts";
import { createService, finished, firstBatch, jobsNet, jobsOptions, work } from "./handler-properties.ts";
import type { RuntimeFactory } from "./properties.ts";
import { lastState } from "./properties.ts";

/** Puts a finished job back on `finished`, so it can fire in every step. */
const again: Transition<"j"> = {
	id: transitionId("again"),
	variables: { j: finished.colourSet },
	guard: () => true,
	inputs: [{ place: finished, variables: ["j"] }],
	outputs: [{ place: finished, expression: ({ j }) => [j] }],
};

/** The jobs net and `again`: the result of `work` puts a job on `finished`, and the net never becomes quiet. */
export const restlessJobsNet: Net = { ...jobsNet, transitions: [again] };

/** How a test breaks the net instance in a conversation, so that the handler task of `work/1` meets it. */
export type Breakage = (harness: Harness, conversationId: ConversationId, runtime: Runtime) => Promise<void>;

/** The host enqueues job j1, which starts `work/1`. Then `plant`, when given, changes the stored instance. */
export function afterEnqueue(plant: ((draft: NetInstanceRecord) => void) | undefined): Breakage {
	return async (harness, conversationId, runtime) => {
		await runtime.instance(harness, conversationId).enqueue(firstBatch(["j1"]), context);
		if (plant !== undefined) {
			await harness.commit(async (tx) => {
				const draft = await tx.doc(netInstanceRecord, conversationId);
				plant(draft);
				// A writer outside the runtime invalidates its cached marking.
				draft.stamp = "";
			}, context);
		}
	};
}

/** A stored log that lost the start of the operation `work/1`, so it names no started operation. */
export function shiftedLog(draft: NetInstanceRecord): void {
	draft.log.splice(1);
}

/** A stored instance that names another net. */
export function otherNet(draft: NetInstanceRecord): void {
	draft.net = "other";
}

/** A stored marking with a place outside the net. */
export function lostPlace(draft: NetInstanceRecord): void {
	draft.marking = { lost: ["j1"] };
}

/** What the host sees after the handler task of a broken net instance ran. */
export type BrokenRun = {
	/** `settled` when the tasks stopped, or the error of a settle that still had a sleeping task. */
	readonly settled: string;
	/** True when `waitForIdle` returned after the settle. It is not called when the settle failed. */
	readonly idle: boolean;
	/** What the Harness reported, as text: each error's name and message. */
	readonly reports: readonly string[];
	/** The outcome of the operation's task when it ended, or else its status. */
	readonly task: string | undefined;
	/** The net instance commits after the breakage. */
	readonly commits: number;
	/** The operations that the stored log holds in flight. */
	readonly inFlight: readonly Operation[];
};

/**
 * A runtime of `net` with the jobs handler, in the root conversation of a new process. `breakage` breaks the net
 * instance, the process settles, and it waits for idle.
 */
export async function brokenRun(factory: RuntimeFactory, net: Net, breakage: Breakage): Promise<BrokenRun> {
	const clock = createClock();
	const service = createService(() => disk.history());
	const runtime = factory({ ...jobsOptions(service, clock), net });
	const disk = createDisk([runtime.extension], clock);
	const { harness, settle } = await disk.open();
	try {
		const root = await harness.root(context);
		await breakage(harness, root.id, runtime);
		const broken = disk.history().length;
		const [task] = (await harness.inspect(context)).tasks;
		if (task === undefined) {
			throw new Error("the breakage started no task");
		}
		const settled = await settle().then(
			() => "settled",
			(error: unknown) => String(error),
		);
		const idle = settled === "settled" && (await harness.waitForIdle(context).then(() => true));
		return {
			settled,
			idle,
			reports: disk.reports().map(String),
			task: await outcomeOf(harness, task),
			commits: disk.history().length - broken,
			inFlight: operationsInFlight(new Set([work.id]), lastState(disk.history()).log),
		};
	} finally {
		await harness.close(context);
	}
}

/** The outcome of a task that ended, or else its status. */
async function outcomeOf(harness: Harness, task: TaskInspection): Promise<string | undefined> {
	const state = (await harness.getTask(task.record.id, context))?.state;
	return state?.status === "terminal" ? state.outcome.status : state?.status;
}
