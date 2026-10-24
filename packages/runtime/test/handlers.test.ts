import fc from "fast-check";
import type { Binding, Token, Transition } from "@petrus/petri-net";
import { definitionOrder, fire, markingProblems, netProblems, placeId, transitionId } from "@petrus/petri-net";
import { describe, expect, test } from "vitest";
import type { Handler, HandlerTransition, Ingress, NetInstanceState, Operation, RuntimeOptions } from "../src/index.ts";
import { busyPlaceId, createRuntime, resultPlaceId, withHandlers } from "../src/index.ts";
import { resultToken } from "../src/handlers.ts";
import { admitResult, hostBatchProblems, operationsInFlight, startedOperations } from "../src/operations.ts";
import { createSettle } from "../src/settle.ts";
import type { Disk } from "./controlled-store.ts";
import { createDisk, ReplyLost } from "./controlled-store.ts";
import {
	createService,
	finished,
	handlerFaultProperty,
	handlerRaceProperty,
	jobsNet,
	jobsState,
	plainJobsNet,
	queue,
	receipts,
	refused,
	slots,
	work,
} from "./handler-properties.ts";

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

function options(disk: Disk, handler: Handler, overrides: Partial<RuntimeOptions> = {}): RuntimeOptions {
	return {
		net: jobsNet,
		store: disk.open(),
		policy: definitionOrder,
		clock: { now: () => 7 },
		handlers: [handler],
		...overrides,
	};
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
		const begun = fire(transitionOf("work"), binding, jobsState(["j1"]).marking);
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
		expect(admitResult(plainJobsNet, handlerIds, state, "work/0", value, 9)).toStrictEqual({
			kind: "applied",
			ingress,
			state: { marking: { [busy]: [started.binding], [result]: ingress.tokens[result] }, log: [started, ingress] },
		});
		const later = { marking: state.marking, log: [started, ingress] };
		expect(
			admitResult(plainJobsNet, handlerIds, later, "work/0", { variant: "refused", value: "refused" }, 10),
		).toStrictEqual({ kind: "repeated", ingress });
	});

	test("refuses a result for no started operation, or one the transition does not declare, which is a bug", () => {
		const state: NetInstanceState = { marking: { [busy]: [started.binding] }, log: [started] };
		expect(() =>
			admitResult(plainJobsNet, handlerIds, state, "work/1", { variant: "done", value: "receipt" }, 9),
		).toThrow(new Error("no operation work/1 has started"));
		const message =
			'invalid batch result:work/0: marking: {"binding":{"j":"j1","s":"slot"},"value":null,"variant":"lost"} on work:result is not in work result';
		expect(() => admitResult(plainJobsNet, handlerIds, state, "work/0", { variant: "lost", value: null }, 9)).toThrow(
			message,
		);
		const recorded = admitResult(
			plainJobsNet,
			handlerIds,
			state,
			"work/0",
			{ variant: "refused", value: "refused" },
			9,
		);
		const later = recorded.kind === "applied" ? recorded.state : state;
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
	test("a step starts an operation but runs no handler; complete records its result and a step ends it", async () => {
		const disk = createDisk(jobsState(["j1"]));
		const service = createService(disk);
		const runtime = createRuntime(options(disk, service.handler));
		expect((await runtime.step()).fired).toStrictEqual([started]);
		expect(service.calls().size).toBe(0);
		expect(await runtime.inFlight()).toStrictEqual([{ id: "work/0", transition: work.id, binding: started.binding }]);
		const value = { variant: "done", value: "receipt 1" };
		const ingress = await runtime.complete("work/0", value);
		expect(ingress.requestId).toBe("result:work/0");
		expect(await runtime.complete("work/0", { variant: "refused", value: "refused" })).toStrictEqual(ingress);
		expect(await runtime.inFlight()).toStrictEqual([]);
		const ended = { busy: started.binding, result: resultToken(started.binding, value) };
		expect((await runtime.step()).fired).toStrictEqual([
			{ kind: "occurrence", transition: transitionId("work:done"), binding: ended, at: 7 },
		]);
		expect(disk.stored().marking).toStrictEqual({
			[slots.id]: ["slot", "slot"],
			[finished.id]: ["j1"],
			[receipts.id]: ["receipt 1"],
		});
	});

	test("settle runs every handler, records each result, and steps until the net is quiet", async () => {
		const disk = createDisk(jobsState(["j1", "j3"]));
		const service = createService(disk);
		const fired = await createRuntime(options(disk, service.handler)).settle();
		expect(fired.map((occurrence) => occurrence.transition)).toStrictEqual([
			"work",
			"work",
			"work:done",
			"work:refused",
		]);
		expect(disk.stored().marking).toStrictEqual({
			[slots.id]: ["slot", "slot"],
			[finished.id]: ["j1"],
			[receipts.id]: ['receipt "j1" run 1'],
			[refused.id]: ["j3"],
		});
		expect([...service.calls()]).toStrictEqual([
			["work/0", 1],
			["work/1", 1],
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
		const disk = createDisk(jobsState(["j1"]));
		const ran: string[] = [];
		const otherHandler: Handler<"j"> = {
			transition: other,
			run: (binding, { operationId }) => {
				ran.push(operationId);
				return Promise.resolve({ variant: "done", value: binding.j });
			},
		};
		const handlers = [otherHandler, createService(disk).handler];
		await createRuntime({ ...options(disk, otherHandler), handlers }).settle();
		expect(ran).toStrictEqual(["other/3"]);
		expect(disk.stored().marking[refused.id]).toStrictEqual(["j1"]);
	});

	test("settle with no handlers steps until nothing fires", async () => {
		const disk = createDisk(jobsState(["j1"]));
		const runtime = createRuntime({ ...options(disk, createService(disk).handler), handlers: [] });
		expect(await runtime.settle()).toStrictEqual([]);
		expect(await runtime.inFlight()).toStrictEqual([]);
	});

	test("a settle reports a handler's error; the operation stays in flight, and the next settle runs it again", async () => {
		const disk = createDisk(jobsState(["j1"]));
		const service = createService(disk);
		let outage = true;
		const flaky: Handler = {
			transition: work,
			run: async (binding, context) => {
				if (outage) {
					outage = false;
					throw new Error("service is down");
				}
				return service.handler.run(binding, context);
			},
		};
		const runtime = createRuntime(options(disk, flaky));
		await expect(runtime.settle()).rejects.toThrow("service is down");
		expect((await runtime.inFlight()).map((operation) => operation.id)).toStrictEqual(["work/0"]);
		await runtime.settle();
		expect(disk.stored().marking[finished.id]).toStrictEqual(["j1"]);
	});

	test("one settle reports a failed run; another settle that waits on it runs it again", async () => {
		const disk = createDisk(jobsState(["j2"]));
		let open = (): void => undefined;
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const service = createService(disk, () => gate);
		const runtime = createRuntime(options(disk, service.handler));
		await runtime.step();
		const both = Promise.allSettled([runtime.settle(), runtime.settle()]);
		// The store answers at once, so a few turns of the microtask queue bring both settles to the run in flight.
		for (let turn = 0; turn < 50; turn += 1) {
			await Promise.resolve();
		}
		open();
		const outcomes = await both;
		expect(outcomes.map((outcome) => outcome.status).sort()).toStrictEqual(["fulfilled", "rejected"]);
		expect(service.calls().get("work/0")).toBe(2);
		expect(disk.stored().marking[finished.id]).toStrictEqual(["j2"]);
	});

	test("after a lost reply on a result, the next settle ends the operation without running it again", async () => {
		const disk = createDisk(jobsState(["j1"]));
		const service = createService(disk);
		const runtime = createRuntime(options(disk, service.handler, { store: disk.open({ loseReplyAtCommit: 1 }) }));
		await expect(runtime.settle()).rejects.toThrow(ReplyLost);
		await runtime.settle();
		expect(service.calls().get("work/0")).toBe(1);
		expect(disk.stored().marking[finished.id]).toStrictEqual(["j1"]);
	});

	test("refuses a host batch that uses a result request id or fills a place the runtime owns, and commits nothing", async () => {
		const disk = createDisk(jobsState([]));
		const runtime = createRuntime(options(disk, createService(disk).handler));
		await expect(
			runtime.enqueue({ requestId: "result:work/0", tokens: { [busy]: [{ j: "j1", s: "slot" }] } }),
		).rejects.toThrow(
			new Error(
				'invalid batch result:work/0: the request id starts with "result:", which the runtime keeps for handler results; place work:busy is filled only by the runtime',
			),
		);
		expect(disk.stored()).toStrictEqual(jobsState([]));
	});

	test("refuses a handler transition whose parts clash with the net, and names every problem", () => {
		const disk = createDisk(jobsState([]));
		const clash = { ...jobsNet, places: [...jobsNet.places, { id: busy, colourSet: queue.colourSet }] };
		expect(() => createRuntime({ ...options(disk, createService(disk).handler), net: clash })).toThrow(
			new Error("invalid net: work:busy: id used 2 times"),
		);
	});
});

describe("createSettle", () => {
	const operation: Operation = { id: "ghost/0", transition: transitionId("ghost"), binding: {} };

	test("rejects when no handler runs an operation, and leaves it to the next settle", async () => {
		let completes = 0;
		const settle = createSettle(
			{
				step: () => Promise.resolve({ fired: [], state: { marking: {}, log: [] } }),
				inFlight: () => Promise.resolve([operation]),
				complete: () => {
					completes += 1;
					return Promise.reject(new Error("never called"));
				},
			},
			[],
		);
		await expect(settle()).rejects.toThrow(new Error("no handler runs ghost"));
		await expect(settle()).rejects.toThrow(new Error("no handler runs ghost"));
		expect(completes).toBe(0);
	});
});

describe("createRuntime with handlers, simulation", () => {
	test("each job ends once after a crash, a lost reply or a failed commit at any commit of a settle", async () => {
		await fc.assert(handlerFaultProperty(createRuntime));
	});

	test("concurrent settles run each operation once, under any order of the store and the handlers", async () => {
		await fc.assert(handlerRaceProperty(createRuntime));
	});
});
