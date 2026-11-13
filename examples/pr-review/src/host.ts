import type { Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineTask, Harness } from "@earendil-works/pi-durable";
import type { HarnessOptions, Storage, Task } from "@earendil-works/pi-durable";
import { definitionOrder } from "@petrus/petri-net";
import type { Clock, ExecutionInput, HandlerResult, LogEntry, NetInstance, Runtime } from "@petrus/runtime";
import { createRuntime, execution } from "@petrus/runtime";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readDiff } from "./diff.ts";
import { GitHubFailure } from "./github.ts";
import type { GitHub, Pull } from "./github.ts";
import { Head, hostInitial, hostNet, HostReport, HostWork, mode, publish } from "./host-net.ts";
import { commits, review } from "./net.ts";
import { marker, renderReview } from "./publication.ts";
import { settleFindings } from "./pull-reviewer.ts";
import type { PullReviewer } from "./pull-reviewer.ts";

export type HostDeps = {
	readonly github: GitHub;
	readonly reviewer: PullReviewer;
	/** The `gh` login that posts reviews, and the only author whose reviews count as already posted. */
	readonly author: string;
	readonly clock: Clock;
	readonly log: (line: string) => void;
};

/** A transient GitHub failure waits 60 s, then 120 s, as GitHub asks after rate limits. A third failure faults. */
const retryDelays = [60_000, 120_000];
const diffBudget = 200_000;
const short = (sha: string): string => sha.slice(0, 7);

type Attempt = { readonly phase: "run"; readonly attempt: number };

function retrying(
	name: string,
	log: HostDeps["log"],
	work: (input: ExecutionInput, context: Context) => Promise<HandlerResult>,
): Task<ExecutionInput, Attempt, HandlerResult, object> {
	return defineTask<ExecutionInput, Attempt, HandlerResult>({
		name,
		version: 1,
		initial: () => ({ phase: "run", attempt: 0 }),
		phases: {
			run: async ({ input, state }, rt, ctx) => {
				const { attempt } = state.checkpoint;
				let result: HandlerResult;
				try {
					result = await work(input, ctx);
				} catch (error) {
					const delay = retryDelays[attempt];
					if (!(error instanceof GitHubFailure && error.transient) || delay === undefined) throw error;
					log(`${input.id}: ${error.message}; retrying in ${String(delay / 1000)} s`);
					return rt.sleepUntil(rt.now() + delay, { phase: "run", attempt: attempt + 1 }, ctx);
				}
				return rt.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), ctx);
			},
		},
		abort: (_task, rt, ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
}

/** Review reads the immutable diff of the selected commit; Publish posts at most one review per report. */
function createHostRuntime(deps: HostDeps, nonce: string): Runtime {
	const reviewTask = retrying("petrus-review:review", deps.log, async (input, context) => {
		const { c, m } = Value.Parse(Type.Object({ w: HostWork }), input.binding).w;
		const diff = readDiff(await deps.github.compare(c.base, c.sha), diffBudget);
		const found = await deps.reviewer({ sha: c.sha, diff: diff.text, previous: m.findings }, context);
		const value = settleFindings(found, diff, m.findings, c.sha);
		deps.log(`Reviewed head ${String(c.seq)} (${short(c.sha)}): ${String(value.length)} findings`);
		return { variant: "reviewed", value };
	});
	const publishTask = retrying("petrus-review:publish", deps.log, async (input) => {
		const { o, m } = Value.Parse(
			Type.Object({ o: HostReport, m: Type.Object({ publish: Type.Boolean() }) }),
			input.binding,
		);
		const payload = renderReview(o, deps.author);
		if (!m.publish) {
			deps.log(`Dry run; would post on head ${String(o.seq)}:\n${JSON.stringify(payload, null, 2)}`);
			return { variant: "published", value: null };
		}
		// A review that a crashed attempt posted carries the marker, so the repeat finds it instead of posting again.
		const posted =
			(await deps.github.findReview(deps.author, marker(o))) ?? (await deps.github.createReview(payload));
		deps.log(`Published the review of head ${String(o.seq)} (${short(o.sha)}): ${posted.url}`);
		return { variant: "published", value: posted };
	});
	return createRuntime({
		name: "petrus-review",
		nonce,
		net: hostNet,
		executions: [execution(review, reviewTask), execution(publish, publishTask)],
		policy: definitionOrder,
		clock: deps.clock,
		startLimit: 10_000,
	});
}

export type Host = { readonly runtime: Runtime; readonly harness: Harness; readonly instance: NetInstance };

/**
 * Opens one process of the host over `storage` and the pull request's net instance in its root conversation.
 * A fresh nonce names this runtime object. A stored instance must have been created with the same publish option.
 */
export async function openHost(
	storage: Storage,
	deps: HostDeps,
	options: {
		readonly publishing: boolean;
		readonly nonce: string;
		readonly harness: Pick<HarnessOptions, "onWake" | "onReport">;
	},
	context: Context,
): Promise<Host> {
	const runtime = createHostRuntime(deps, options.nonce);
	const registry = createRegistry();
	registry.install(runtime.extension);
	const harness = await Harness.open(
		storage,
		{ ...options.harness, models: createModels(), registry, now: deps.clock.now },
		context,
	);
	try {
		return { runtime, harness, instance: await openPull(runtime, harness, options.publishing, context) };
	} catch (error) {
		await harness.close(context);
		throw error;
	}
}

async function openPull(
	runtime: Runtime,
	harness: Harness,
	publishing: boolean,
	context: Context,
): Promise<NetInstance> {
	const instance = runtime.instance(harness, (await harness.root(context)).id);
	const first = (await instance.state(context)).log.find(
		(entry) => entry.kind === "ingress" && entry.requestId === "initial",
	);
	if (first?.kind === "ingress" && !Value.Equal(first.tokens[mode.id], [{ publish: publishing }])) {
		throw new Error(
			`This state directory was created ${publishing ? "without" : "with"} --publish. ` +
				"Run with the same option, or use another --state directory.",
		);
	}
	await instance.enqueue({ requestId: "initial", tokens: hostInitial(publishing) }, context);
	return instance;
}

/**
 * Admits the pull request's head when it differs from the last admitted head, as the next observation.
 * The sequence number comes from the log, so it survives a restart. Returns the new sequence number, if any.
 */
export async function observe(instance: NetInstance, pull: Pull, context: Context): Promise<number | undefined> {
	const last = lastHead((await instance.state(context)).log);
	if (last?.sha === pull.head) return undefined;
	const seq = (last?.seq ?? 0) + 1;
	await instance.enqueue(
		{ requestId: `head:${String(seq)}`, tokens: { [commits.id]: [{ seq, sha: pull.head, base: pull.base }] } },
		context,
	);
	return seq;
}

function lastHead(log: readonly LogEntry[]): { readonly seq: number; readonly sha: string } | undefined {
	const entry = log.findLast((candidate) => candidate.kind === "ingress" && candidate.requestId.startsWith("head:"));
	return entry?.kind === "ingress" ? Value.Parse(Head, entry.tokens[commits.id]?.[0]) : undefined;
}

export type Watch = {
	readonly github: GitHub;
	readonly instance: NetInstance;
	readonly log: (line: string) => void;
	/** Waits one poll interval. */
	readonly wait: () => Promise<void>;
	/** True after an interrupt or a faulted task. */
	readonly stopped: () => boolean;
};

/** Polls the pull request until it closes or `stopped`. Returns true when it closed. */
export async function watch(options: Watch, context: Context): Promise<boolean> {
	let reported = 0;
	while (!options.stopped()) {
		const open = await poll(options, context);
		reported = await reportWithheld(options, reported, context);
		if (!open) return true;
		await options.wait();
	}
	return false;
}

/** Returns false when the pull request is closed or merged. A transient read failure waits for the next poll. */
async function poll({ github, instance, log }: Watch, context: Context): Promise<boolean> {
	const pull = await readPull(github, log);
	if (pull === undefined) return true;
	if (!pull.open) return false;
	const seq = await observe(instance, pull, context);
	if (seq !== undefined) log(`Admitted head ${String(seq)} (${short(pull.head)})`);
	return true;
}

async function readPull(github: GitHub, log: Watch["log"]): Promise<Pull | undefined> {
	try {
		return await github.pull();
	} catch (error) {
		if (!(error instanceof GitHubFailure && error.transient)) throw error;
		log(`Could not read the pull request: ${error.message}`);
		return undefined;
	}
}

async function reportWithheld({ instance, log }: Watch, from: number, context: Context): Promise<number> {
	const entries = (await instance.state(context)).log;
	for (const entry of entries.slice(from)) {
		if (entry.kind !== "occurrence" || entry.transition !== "Withhold") continue;
		const r = Value.Parse(Head, entry.binding.r);
		const c = Value.Parse(Head, entry.binding.c);
		log(`Withheld the review of head ${String(r.seq)} (${short(r.sha)}): head ${String(c.seq)} came first`);
	}
	return entries.length;
}
