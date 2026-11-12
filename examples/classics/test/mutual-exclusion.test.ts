import { randomUUID } from "node:crypto";
import type { CommitPublication, Harness, TaskId } from "@earendil-works/pi-durable";
import { defineExtension, defineTask } from "@earendil-works/pi-durable";
import fc from "fast-check";
import type { Marking, Token } from "@petrus/petri-net";
import { definitionOrder, tokensAt } from "@petrus/petri-net";
import type { ExecutionInput, HandlerResult, NetInstanceHost, Runtime } from "@petrus/runtime";
import { busyPlaceId, createRuntime, execution } from "@petrus/runtime";
import { replay } from "@petrus/runtime-replay";
import { describe, expect, test } from "vitest";
import type { Resource } from "../src/mutual-exclusion.ts";
import {
	critical,
	finished,
	initialMarking,
	mutex,
	mutualExclusion,
	mutualExclusionHandlers,
} from "../src/mutual-exclusion.ts";
import { clock, context, createDisk, runToEnd } from "./disk.ts";

type SharedResource = Resource & {
	/** Each time two holders were inside at once: their operation ids. */
	readonly overlaps: () => readonly (readonly string[])[];
	/** The process of each operation that used the resource and left. */
	readonly uses: () => ReadonlyMap<string, Token>;
};

/** A resource that records when two holders are inside. A holder is an operation, so a second run of one is the same holder. */
function sharedResource(pause: () => Promise<void>): SharedResource {
	const inside = new Map<string, number>();
	const overlaps: string[][] = [];
	const uses = new Map<string, Token>();
	const enter = (operationId: string): void => {
		inside.set(operationId, (inside.get(operationId) ?? 0) + 1);
		if (inside.size > 1) {
			overlaps.push([...inside.keys()]);
		}
	};
	const leave = (operationId: string): void => {
		const left = (inside.get(operationId) ?? 1) - 1;
		if (left === 0) {
			inside.delete(operationId);
		} else {
			inside.set(operationId, left);
		}
	};
	return {
		use: async (process, operationId) => {
			enter(operationId);
			await pause();
			leave(operationId);
			uses.set(operationId, process);
		},
		overlaps: () => overlaps,
		uses: () => uses,
	};
}

function runtimeOf(resource: Resource): Runtime {
	return createRuntime({
		name: "mutual-exclusion",
		nonce: randomUUID(),
		net: mutualExclusion,
		policy: definitionOrder,
		clock,
		executions: mutualExclusionHandlers(resource),
		startLimit: 100,
	});
}

/** The resource token is on `mutex` or held by the one process in its critical section. */
function oneHolder(marking: Marking): boolean {
	return tokensAt(marking, mutex.id).length + tokensAt(marking, busyPlaceId(critical.id)).length === 1;
}

describe("mutual exclusion", () => {
	test("lets each process in once, one at a time, and gives the resource token back", async () => {
		const disk = createDisk();
		const resource = sharedResource(() => Promise.resolve());
		await runToEnd(disk, runtimeOf(resource), initialMarking(3), undefined);
		expect(disk.last()).toStrictEqual({ [mutex.id]: ["lock"], [finished.id]: ["p1", "p2", "p3"] });
		expect(resource.overlaps()).toStrictEqual([]);
	});

	test("never has two holders inside, under any order of work and a crash at any commit", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.scheduler(),
				fc.integer({ min: 1, max: 4 }),
				fc.option(fc.nat({ max: 12 }), { nil: undefined }),
				async (scheduler, processCount, crashAt) => {
					const disk = createDisk();
					const resource = sharedResource(() => scheduler.schedule(Promise.resolve(), "inside"));
					await runToEnd(disk, runtimeOf(resource), initialMarking(processCount), crashAt, (settling) =>
						scheduler.waitFor(settling),
					);
					const processes = Array.from({ length: processCount }, (_, index) => `p${String(index + 1)}`);
					return (
						disk.history().every((state) => oneHolder(state)) &&
						resource.overlaps().length === 0 &&
						JSON.stringify([...tokensAt(disk.last(), finished.id)].sort()) === JSON.stringify(processes) &&
						JSON.stringify([...resource.uses().values()].sort()) === JSON.stringify(processes)
					);
				},
			),
		);
	});
});

type Observation = Pick<CommitPublication, "changes">;

function familyRuntime(pause: (label: string) => Promise<void>, publications: Observation[]): Runtime {
	const child = defineTask<string, { readonly phase: "work" }, null>({
		name: "critical-test:child",
		version: 1,
		initial: () => ({ phase: "work" }),
		phases: {
			work: async ({ input }, runtime, callContext) => {
				await pause(input);
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
					callContext,
				);
			},
		},
		abort: async (_task, runtime, callContext) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext);
		},
	});
	const parent = defineTask<ExecutionInput, { readonly phase: "start" | "finish" }, HandlerResult>({
		name: "critical-test:parent",
		version: 1,
		initial: () => ({ phase: "start" }),
		phases: {
			start: async ({ id }, runtime, callContext) => {
				await runtime.commit(async (tx) => {
					for (const label of ["left", "right"]) {
						await tx.createTask(child, label, { ownership: { kind: "task", taskId: id } });
					}
					return { status: "running", checkpoint: { phase: "finish" } };
				}, callContext);
			},
			finish: async ({ input }, runtime, callContext) => {
				const process = input.binding.process;
				if (process === undefined) throw new Error("critical section has no process");
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "completed", result: { variant: "left", value: process } },
					}),
					callContext,
				);
			},
		},
		abort: async (_task, runtime, callContext) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), callContext);
		},
	});
	const runtime = createRuntime({
		name: "critical-family",
		nonce: randomUUID(),
		net: mutualExclusion,
		policy: definitionOrder,
		clock,
		startLimit: 2,
		executions: [execution(critical, parent)],
	});
	return {
		...runtime,
		extension: defineExtension({ name: "critical-family:test", tasks: [...(runtime.extension.tasks ?? []), child] }),
		instance: (host, conversationId) => {
			if (!observableHost(host)) throw new Error("the test requires a real Harness");
			host.subscribeCommits((publication) => publications.push(publication));
			const instance = runtime.instance(host, conversationId);
			return {
				...instance,
				enqueue: async (batch, callContext) => {
					const page = await host.commit((tx) => tx.scanTasks({ conversationId }, 100), callContext);
					expect(page.next).toBeUndefined();
					publications.push({ changes: page.items.map((value) => ({ type: "task", value })) });
					return instance.enqueue(batch, callContext);
				},
			};
		},
	};
}

function observableHost(host: NetInstanceHost): host is Harness {
	return "subscribeCommits" in host;
}

type StoredTask = Extract<CommitPublication["changes"][number], { readonly type: "task" }>["value"];

function checkFamilyParent(parent: StoredTask, tasks: readonly StoredTask[], marking: unknown): number {
	const children = tasks.filter((task) => task.owner === parent.id);
	const live = children.filter((task) => task.state.status !== "terminal");
	if (parent.state.status === "terminal") {
		expect(parent.state.outcome, JSON.stringify(parent.state.outcome)).toMatchObject({ status: "completed" });
		expect(live).toHaveLength(0);
	}
	if (parent.state.status !== "completing") return -1;
	expect(children).toHaveLength(2);
	expect(marking).toMatchObject({ [busyPlaceId(critical.id)]: [parentBinding(parent)] });
	return live.length;
}

function parentBinding(parent: StoredTask): unknown {
	const input = parent.input;
	if (typeof input !== "object" || input === null || Array.isArray(input))
		throw new Error("parent input must be an operation");
	return input.binding;
}

function checkFamilyCommits(publications: readonly Observation[]): void {
	const tasks = new Map<TaskId, StoredTask>();
	const heldCounts = new Set<number>();
	let marking: unknown;
	for (const publication of publications) {
		publication.changes.forEach((change) => {
			if (change.type === "task") tasks.set(change.value.id, change.value);
			if (change.type === "document" && change.record.kind === "petrus.net-instance")
				marking = change.value?.marking;
		});
		const parents = [...tasks.values()].filter((task) => task.kind === "critical-test:parent");
		parents.forEach((parent) => heldCounts.add(checkFamilyParent(parent, [...tasks.values()], marking)));
	}
	expect(heldCounts.has(2)).toBe(true);
	expect(heldCounts.has(1)).toBe(true);
}

function checkReplay(publications: readonly Observation[], runtime: Runtime, log: Parameters<typeof replay>[1]): void {
	const frames = replay(runtime.net, log);
	for (const publication of publications) {
		publication.changes.forEach((change) => {
			if (change.type !== "document" || change.record.kind !== "petrus.net-instance" || change.value === null)
				return;
			const committedLog = change.value.log;
			if (!Array.isArray(committedLog)) throw new Error("net commit has no log");
			expect(frames.at(committedLog.length)).toHaveProperty("marking", change.value.marking);
		});
	}
}

test("holds the mutex through native completion and both owned children, under generated completion orders and crashes", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.scheduler(),
			fc.option(fc.integer({ min: 3, max: 35 }), { nil: undefined }),
			async (scheduler, crashAt) => {
				const disk = createDisk();
				const publications: Observation[] = [];
				const runtime = familyRuntime(async (label) => {
					await scheduler.schedule(Promise.resolve(), label);
					if (label === "right") await scheduler.schedule(Promise.resolve(), "right second step");
				}, publications);
				await runToEnd(disk, runtime, initialMarking(2), crashAt, (settling) => scheduler.waitFor(settling));
				checkFamilyCommits(publications);
				expect(disk.history().every(oneHolder)).toBe(true);
				expect(disk.last()).toStrictEqual({ [mutex.id]: ["lock"], [finished.id]: ["p1", "p2"] });
				const process = await disk.open(runtime);
				try {
					const state = await process.instance.state(context);
					expect(replay(runtime.net, state.log).at(-1)?.marking).toStrictEqual(state.marking);
					checkReplay(publications, runtime, state.log);
					expect(await process.instance.inFlight(context)).toStrictEqual([]);
				} finally {
					await process.close();
				}
			},
		),
		{ numRuns: 30 },
	);
});
