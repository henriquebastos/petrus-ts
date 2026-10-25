import fc from "fast-check";
import type { Binding, Token, Transition } from "@petrus/petri-net";
import { fire, markingProblems, netProblems, placeId, transitionId } from "@petrus/petri-net";
import { describe, expect, onTestFinished, test } from "vitest";
import type {
	Handler,
	HandlerTransition,
	Ingress,
	NetInstance,
	NetInstanceState,
	RuntimeOptions,
} from "../src/index.ts";
import { busyPlaceId, createRuntime, resultPlaceId, withHandlers } from "../src/index.ts";
import { resultToken } from "../src/handlers.ts";
import {
	admitResult,
	hostBatchProblems,
	operationsInFlight,
	operationsStartedFrom,
	startedOperation,
	startedOperations,
} from "../src/operations.ts";
import { viewOf } from "../src/net-instance-view.ts";
import type { Disk, Process, TestClock } from "./disk.ts";
import { context, createClock, createDisk } from "./disk.ts";
import type { Service } from "./handler-properties.ts";
import {
	createService,
	finished,
	firstBatch,
	handlerFaultProperty,
	handlerRaceProperty,
	jobsNet,
	jobsOptions,
	plainJobsNet,
	queue,
	receipts,
	refused,
	slots,
	work,
} from "./handler-properties.ts";
import { lastState } from "./properties.ts";

const busy = busyPlaceId(work.id);
const result = resultPlaceId(work.id);
const handlerIds = new Set([work.id]);

function transitionOf(id: string): Transition {
	const found = plainJobsNet.transitions.find((transition) => transition.id === transitionId(id));
	if (found === undefined) {
		throw new Error(`no transition ${id}`);
	}
	return found;
}

type Opened = {
	readonly disk: Disk;
	readonly process: Process;
	readonly instance: NetInstance;
	readonly service: Service;
};

/**
 * A runtime of the jobs net in the root conversation of a new process, with the service's handler unless `overrides`
 * names others; the test closes its Harness.
 */
async function opened(
	overrides: (service: Service) => Partial<RuntimeOptions> = () => ({}),
	clock: TestClock = createClock(),
): Promise<Opened> {
	const service = createService(() => disk.history());
	const runtime = createRuntime({ ...jobsOptions(service, clock), ...overrides(service) });
	const disk: Disk = createDisk([runtime.extension], clock);
	const process = await disk.open();
	onTestFinished(() => process.harness.close(context));
	const instance = runtime.instance(process.harness, (await process.harness.root(context)).id);
	return { disk, process, instance, service };
}

const started = { kind: "occurrence", transition: work.id, binding: { j: "j1", s: "slot" }, at: 7 } as const;

describe("withHandlers", () => {
	test("makes a handler transition a start transition, a busy place, a result place and an end per variant", () => {
		expect(plainJobsNet.places.map((place) => place.id)).toStrictEqual([
			...jobsNet.places.map((place) => place.id),
			placeId("work:busy"),
			placeId("work:result"),
		]);
		expect(plainJobsNet.transitions.map((transition) => transition.id)).toStrictEqual([
			transitionId("work"),
			transitionId("work:done"),
			transitionId("work:refused"),
		]);
		expect(netProblems(plainJobsNet)).toStrictEqual([]);
		expect(withHandlers(jobsNet, [])).toStrictEqual(jobsNet);
	});

	test("the start puts the binding on the busy place, and the end of its variant produces the outputs", () => {
		const binding = { j: "j1", s: "slot" };
		const begun = fire(transitionOf("work"), binding, firstBatch(["j1"]).tokens);
		expect(begun).toStrictEqual({ ok: true, value: { [slots.id]: ["slot"], [busy]: [binding] } });
		const ended = resultToken(binding, { variant: "done", value: "receipt 1" });
		const marking = { ...(begun.ok ? begun.value : {}), [result]: [ended] };
		expect(fire(transitionOf("work:done"), { busy: binding, result: ended }, marking)).toStrictEqual({
			ok: true,
			value: { [slots.id]: ["slot", "slot"], [finished.id]: ["j1"], [receipts.id]: ["receipt 1"] },
		});
		expect(fire(transitionOf("work:refused"), { busy: binding, result: ended }, marking)).toStrictEqual({
			ok: false,
			error: { kind: "not-a-binding", transition: "work:refused", problems: ["work:refused: the guard is false"] },
		});
	});

	test("the busy place holds only bindings of the transition, and the result place only declared results", () => {
		const binding = { j: "j1", s: "slot" };
		const tokens: readonly Token[] = [
			{ j: "j1", s: "slot" },
			{ j: "j1", s: "spoon" },
			{ j: "j1" },
			["j1", "slot"],
			null,
			"j1",
		];
		const results: readonly Token[] = [
			{ binding, variant: "done", value: "receipt 1" },
			{ binding, variant: "refused", value: "refused" },
			{ binding, variant: "done", value: "refused" },
			{ binding, variant: "lost", value: "receipt 1" },
			{ binding, variant: 1, value: "receipt 1" },
			{ binding: { j: "j1" }, variant: "done", value: "receipt 1" },
			{ binding, variant: "done" },
			{ binding, variant: "done", value: "receipt 1", extra: 1 },
			["binding", "value", "variant"],
		];
		expect(markingProblems(plainJobsNet, { [busy]: tokens, [result]: results })).toStrictEqual([
			'marking: {"j":"j1","s":"spoon"} on work:busy is not in work binding',
			'marking: {"j":"j1"} on work:busy is not in work binding',
			'marking: ["j1","slot"] on work:busy is not in work binding',
			"marking: null on work:busy is not in work binding",
			'marking: "j1" on work:busy is not in work binding',
			'marking: {"binding":{"j":"j1","s":"slot"},"value":"refused","variant":"done"} on work:result is not in work result',
			'marking: {"binding":{"j":"j1","s":"slot"},"value":"receipt 1","variant":"lost"} on work:result is not in work result',
			'marking: {"binding":{"j":"j1","s":"slot"},"value":"receipt 1","variant":1} on work:result is not in work result',
			'marking: {"binding":{"j":"j1"},"value":"receipt 1","variant":"done"} on work:result is not in work result',
			'marking: {"binding":{"j":"j1","s":"slot"},"variant":"done"} on work:result is not in work result',
			'marking: {"binding":{"j":"j1","s":"slot"},"extra":1,"value":"receipt 1","variant":"done"} on work:result is not in work result',
			'marking: ["binding","value","variant"] on work:result is not in work result',
		]);
	});

	test("the busy place of a handler with no variables holds only the empty binding", () => {
		const ping: HandlerTransition = {
			id: transitionId("ping"),
			variables: {},
			guard: () => true,
			inputs: [],
			variants: { pong: { value: queue.colourSet, outputs: [] } },
		};
		const plain = withHandlers({ places: [], transitions: [] }, [ping]);
		expect(markingProblems(plain, { [busyPlaceId(ping.id)]: [{}, 5, "j1"] })).toStrictEqual([
			"marking: 5 on ping:busy is not in ping binding",
			'marking: "j1" on ping:busy is not in ping binding',
		]);
	});

	test("an end fires only for a result of its own variant and its own run", () => {
		const done = transitionOf("work:done");
		const binding = { j: "j1", s: "slot" };
		const ended = resultToken(binding, { variant: "done", value: "receipt 1" });
		expect(done.guard({ busy: binding, result: ended })).toBe(true);
		expect(done.guard({ busy: { j: "j2", s: "slot" }, result: ended })).toBe(false);
		expect(
			done.guard({ busy: binding, result: resultToken(binding, { variant: "refused", value: "refused" }) }),
		).toBe(false);
		expect(done.guard({ busy: binding, result: "not a result" })).toBe(false);
		expect(done.guard({ busy: { s: "slot", j: "j1" }, result: ended })).toBe(true);
	});

	test("an end's arcs throw on a token outside their places, which is a bug in the runtime", () => {
		const [arc] = transitionOf("work:done").outputs;
		const binding: Binding = { j: "j1", s: "slot" };
		const ended = resultToken(binding, { variant: "done", value: "receipt 1" });
		expect(arc?.expression({ busy: binding, result: ended })).toStrictEqual(["j1"]);
		expect(() => arc?.expression({ busy: "j1", result: ended })).toThrow(
			new TypeError('work: "j1" is not a binding'),
		);
		expect(() => arc?.expression({ busy: binding, result: "j1" })).toThrow(
			new TypeError('work: "j1" is not a result'),
		);
	});
});

describe("operations", () => {
	const log = [
		started,
		{ kind: "occurrence", transition: transitionId("other"), binding: {}, at: 7 },
		{ kind: "ingress", requestId: "delivery-1", tokens: {}, at: 7 },
		{ ...started, binding: { j: "j2", s: "slot" } },
	] as const;

	test("names each operation by its transition and its position in the log", () => {
		expect(startedOperations(handlerIds, log)).toStrictEqual([
			{ id: "work/0", transition: work.id, binding: { j: "j1", s: "slot" } },
			{ id: "work/3", transition: work.id, binding: { j: "j2", s: "slot" } },
		]);
	});

	test("the operations that a commit starts are those of the log entries it appends", () => {
		expect(operationsStartedFrom(handlerIds, log.slice(1), 1)).toStrictEqual([
			{ id: "work/3", transition: work.id, binding: { j: "j2", s: "slot" } },
		]);
		expect(operationsStartedFrom(handlerIds, [], log.length)).toStrictEqual([]);
	});

	test("finds a started operation by the log index in its id, and nothing for an id of no started operation", () => {
		const view = viewOf({ marking: {}, log });
		expect(startedOperation(handlerIds, view, "work/3")).toStrictEqual({
			id: "work/3",
			transition: work.id,
			binding: { j: "j2", s: "slot" },
		});
		const unknown = ["other/1", "work/1", "work/2", "other/0", "work/03", "work/9", "work"];
		expect(unknown.map((id) => startedOperation(handlerIds, view, id))).toStrictEqual(unknown.map(() => undefined));
	});

	test("an operation is in flight until the log holds its result", () => {
		const done = [...log, { kind: "ingress", requestId: "result:work/0", tokens: {}, at: 8 } as const];
		expect(operationsInFlight(handlerIds, done).map((operation) => operation.id)).toStrictEqual(["work/3"]);
	});

	test("puts a result on the result place under the operation's request id; the first result counts", () => {
		const state: NetInstanceState = { marking: { [busy]: [started.binding] }, log: [started] };
		const value = { variant: "done", value: "receipt 1" };
		const ingress: Ingress = {
			kind: "ingress",
			requestId: "result:work/0",
			tokens: { [result]: [resultToken(started.binding, value)] },
			at: 9,
		};
		expect(admitResult(plainJobsNet, handlerIds, viewOf(state), "work/0", value, 9)).toStrictEqual({
			kind: "applied",
			ingress,
			marking: { [busy]: [started.binding], [result]: ingress.tokens[result] },
		});
		const later = viewOf({ marking: state.marking, log: [started, ingress] });
		expect(
			admitResult(plainJobsNet, handlerIds, later, "work/0", { variant: "refused", value: "refused" }, 10),
		).toStrictEqual({ kind: "repeated", ingress });
	});

	test("refuses a result for no started operation, or one the transition does not declare, which is a bug", () => {
		const state: NetInstanceState = { marking: { [busy]: [started.binding] }, log: [started] };
		expect(() =>
			admitResult(plainJobsNet, handlerIds, viewOf(state), "work/1", { variant: "done", value: "receipt" }, 9),
		).toThrow(new Error("no operation work/1 has started"));
		const message =
			'invalid batch result:work/0: marking: {"binding":{"j":"j1","s":"slot"},"value":null,"variant":"lost"} on work:result is not in work result';
		expect(() =>
			admitResult(plainJobsNet, handlerIds, viewOf(state), "work/0", { variant: "lost", value: null }, 9),
		).toThrow(message);
		const recorded = admitResult(
			plainJobsNet,
			handlerIds,
			viewOf(state),
			"work/0",
			{ variant: "refused", value: "refused" },
			9,
		);
		const later = viewOf({ marking: state.marking, log: [started, recorded.ingress] });
		expect(() =>
			admitResult(plainJobsNet, handlerIds, later, "work/0", { variant: "lost", value: null }, 10),
		).toThrow(message);
	});

	test("a host's batch may not use a result request id or fill a place that the runtime owns", () => {
		expect(
			hostBatchProblems(handlerIds, { requestId: "result:work/0", tokens: { [busy]: [], [result]: [] } }),
		).toStrictEqual([
			'the request id starts with "result:", which the runtime keeps for handler results',
			"place work:busy is filled only by the runtime",
			"place work:result is filled only by the runtime",
		]);
		expect(hostBatchProblems(handlerIds, { requestId: "delivery-1", tokens: { [queue.id]: ["j1"] } })).toStrictEqual(
			[],
		);
	});
});

describe("createRuntime with handlers, examples", () => {
	const binding = { j: "j1", s: "slot" };
	const operation = { id: "work/1", transition: work.id, binding };

	test("an enqueue starts an operation and creates its task in one commit; the task runs the handler, records its result and steps until quiet", async () => {
		const { disk, process, instance, service } = await opened(undefined, createClock(5));
		const { fired } = await instance.enqueue(firstBatch(["j1"]), context);
		expect(fired).toStrictEqual([{ kind: "occurrence", transition: work.id, binding, at: 5 }]);
		expect(await instance.inFlight(context)).toStrictEqual([operation]);
		const { tasks } = await process.harness.inspect(context);
		expect(tasks.map(({ record }) => [record.kind, record.input])).toStrictEqual([
			["petrus.operation:jobs", { ...operation, startedAt: 5 }],
		]);
		expect(service.calls().size).toBe(0);
		await process.settle();
		const ended = resultToken(binding, { variant: "done", value: 'receipt "j1" run 1' });
		expect(lastState(disk.history()).log.slice(2)).toStrictEqual([
			{ kind: "ingress", requestId: "result:work/1", tokens: { [result]: [ended] }, at: 5 },
			{
				kind: "occurrence",
				transition: transitionId("work:done"),
				binding: { busy: binding, result: ended },
				at: 5,
			},
		]);
		expect(await instance.state(context)).toMatchObject({
			marking: { [slots.id]: ["slot", "slot"], [finished.id]: ["j1"], [receipts.id]: ['receipt "j1" run 1'] },
		});
		expect(await instance.inFlight(context)).toStrictEqual([]);
		expect(disk.history()).toHaveLength(2);
	});

	test("the handler tasks end every operation by the variant that its handler returns", async () => {
		const { process, instance, service } = await opened();
		await instance.enqueue(firstBatch(["j1", "j3"]), context);
		await process.settle();
		expect((await instance.state(context)).marking).toStrictEqual({
			[slots.id]: ["slot", "slot"],
			[finished.id]: ["j1"],
			[receipts.id]: ['receipt "j1" run 1'],
			[refused.id]: ["j3"],
		});
		expect([...service.calls()]).toStrictEqual([
			["work/1", 1],
			["work/2", 1],
		]);
	});

	test("each operation runs the handler of its own transition", async () => {
		const other: HandlerTransition<"j"> = {
			id: transitionId("other"),
			variables: { j: queue.colourSet },
			guard: () => true,
			inputs: [{ place: finished, variables: ["j"] }],
			variants: {
				done: { value: queue.colourSet, outputs: [{ place: refused, expression: (_binding, j) => [j] }] },
			},
		};
		const ran: string[] = [];
		const otherHandler: Handler<"j"> = {
			transition: other,
			run: (started, { operationId }) => {
				ran.push(operationId);
				return Promise.resolve({ variant: "done", value: started.j });
			},
		};
		const { process, instance, service } = await opened((jobs) => ({ handlers: [otherHandler, jobs.handler] }));
		await instance.enqueue(firstBatch(["j1"]), context);
		await process.settle();
		expect(ran).toStrictEqual(["other/4"]);
		expect([...service.calls()]).toStrictEqual([["work/1", 1]]);
		expect((await instance.state(context)).marking[refused.id]).toStrictEqual(["j1"]);
	});

	test("two runtimes with their own names run their operations side by side in one Harness", async () => {
		const clock = createClock();
		const services = [createService(() => disk.history()), createService(() => disk.history())] as const;
		const runtimes = [
			createRuntime({ ...jobsOptions(services[0], clock), name: "jobs-a" }),
			createRuntime({ ...jobsOptions(services[1], clock), name: "jobs-b" }),
		] as const;
		const disk: Disk = createDisk(
			runtimes.map((runtime) => runtime.extension),
			clock,
		);
		const process = await disk.open();
		onTestFinished(() => process.harness.close(context));
		const root = await process.harness.root(context);
		const other = await process.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const instances = [
			runtimes[0].instance(process.harness, root.id),
			runtimes[1].instance(process.harness, other.id),
		];
		for (const instance of instances) {
			await instance.enqueue(firstBatch(["j1"]), context);
		}
		await process.settle();
		for (const instance of instances) {
			expect(await instance.inFlight(context)).toStrictEqual([]);
			expect((await instance.state(context)).marking[finished.id]).toStrictEqual(["j1"]);
		}
	});

	test("a handler's throw is reported, and the operation stays in flight and runs again after retryDelayMs", async () => {
		const clock = createClock(100);
		const runs: number[] = [];
		const flaky = (service: Service): Handler => ({
			transition: work,
			run: (started, handlerContext) => {
				runs.push(clock.now());
				return runs.length === 1
					? Promise.reject(new Error("the service is down"))
					: service.handler.run(started, handlerContext);
			},
		});
		const { disk, process, instance } = await opened((service) => ({ handlers: [flaky(service)] }), clock);
		await instance.enqueue(firstBatch(["j1"]), context);
		await process.runReady();
		expect(disk.reports()).toStrictEqual([new Error("the service is down")]);
		expect(await instance.inFlight(context)).toStrictEqual([operation]);
		expect(process.harness.wake()).toStrictEqual({ active: false, at: 110 });
		await process.settle();
		expect(runs).toStrictEqual([100, 110]);
		expect((await instance.state(context)).marking[finished.id]).toStrictEqual(["j1"]);
	});

	test("a task whose transition has no handler, as after the host dropped it, is reported and runs again after retryDelayMs", async () => {
		const clock = createClock();
		const service = createService(() => []);
		const withHandler = createRuntime(jobsOptions(service, clock));
		const withoutHandler = createRuntime({ ...jobsOptions(service, clock), handlers: [] });
		const disk = createDisk([withoutHandler.extension], clock);
		const process = await disk.open();
		onTestFinished(() => process.harness.close(context));
		const root = await process.harness.root(context);
		await withHandler.instance(process.harness, root.id).enqueue(firstBatch(["j1"]), context);
		await process.runReady();
		expect(disk.reports()).toStrictEqual([new Error("no handler runs work")]);
		expect(process.harness.wake()).toStrictEqual({ active: false, at: 10 });
		expect(service.calls().size).toBe(0);
	});

	test("aborting a handler task ends it as aborted without running the handler, and its operation stays in flight", async () => {
		const { process, instance, service } = await opened();
		await instance.enqueue(firstBatch(["j1"]), context);
		const [task] = (await process.harness.inspect(context)).tasks;
		if (task === undefined) {
			throw new Error("the enqueue created no task");
		}
		const { id } = task.record;
		expect(await process.harness.abortTask(id, context)).toBe("marked");
		await process.settle();
		expect((await process.harness.getTask(id, context))?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "aborted" },
		});
		expect(service.calls().size).toBe(0);
		expect(await instance.inFlight(context)).toStrictEqual([operation]);
	});

	test("aborting a task while its handler runs ends it as aborted, records no result and reports nothing", async () => {
		let entered = (): void => undefined;
		let finish = (): void => undefined;
		const running = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const slow: Handler<"j" | "s"> = {
			transition: work,
			run: () =>
				new Promise((resolve) => {
					finish = () => {
						resolve({ variant: "done", value: "late" });
					};
					entered();
				}),
		};
		const { disk, process, instance } = await opened(() => ({ handlers: [slow] }));
		await instance.enqueue(firstBatch(["j1"]), context);
		process.harness.resume();
		await running;
		const [task] = (await process.harness.inspect(context)).tasks;
		if (task === undefined) {
			throw new Error("the enqueue created no task");
		}
		const aborted = process.harness.abortTask(task.record.id, context);
		finish();
		expect(await aborted).toBe("marked");
		await process.settle();
		expect((await process.harness.getTask(task.record.id, context))?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "aborted" },
		});
		expect(disk.reports()).toStrictEqual([]);
		expect(await instance.inFlight(context)).toStrictEqual([operation]);
	});

	test("refuses a host batch that uses a result request id or fills a place the runtime owns, and commits nothing", async () => {
		const { disk, instance } = await opened();
		await expect(
			instance.enqueue({ requestId: "result:work/0", tokens: { [busy]: [{ j: "j1", s: "slot" }] } }, context),
		).rejects.toThrow(
			new Error(
				'invalid batch result:work/0: the request id starts with "result:", which the runtime keeps for handler results; place work:busy is filled only by the runtime',
			),
		);
		expect(disk.history()).toStrictEqual([]);
	});

	test("refuses a handler transition whose parts clash with the net, and names every problem", () => {
		const service = createService(() => []);
		const clash = { ...jobsNet, places: [...jobsNet.places, { id: busy, colourSet: queue.colourSet }] };
		expect(() => createRuntime({ ...jobsOptions(service, createClock()), net: clash })).toThrow(
			new Error("invalid net: work:busy: id used 2 times"),
		);
	});
});

describe("createRuntime with handlers, simulation", () => {
	test("each job ends once after a crash before or after any commit, and after the service's outage", async () => {
		await fc.assert(handlerFaultProperty(createRuntime));
	});

	test("each operation runs once, at most two at once, under any order of handler ends and a late batch", async () => {
		await fc.assert(handlerRaceProperty(createRuntime));
	});
});
