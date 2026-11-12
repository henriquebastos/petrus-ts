import { randomUUID } from "node:crypto";
import fc from "fast-check";
import type { Marking, Token } from "@petrus/petri-net";
import { definitionOrder, placeId, tokensAt } from "@petrus/petri-net";
import type { NetInstance, Runtime, Signal } from "@petrus/runtime";
import { createRuntime } from "@petrus/runtime";
import { describe, expect, onTestFinished, test } from "vitest";
import type { Shop } from "../src/order-process.ts";
import { abortable, done, initialMarking, orderProcess, orderProcessHandlers } from "../src/order-process.ts";
import { clock, context, createDisk, runToEnd } from "./disk.ts";
import { flush } from "./flush.ts";

type FakeShop = Shop & {
	/** The orders whose stock is reserved now. */
	readonly reservations: () => ReadonlySet<Token>;
	/** The orders whose payment is taken now. */
	readonly payments: () => ReadonlySet<Token>;
};

/** Rejects once `signal` aborts. */
function untilAborted(signal: Signal): Promise<never> {
	return new Promise((_resolve, reject) => {
		const abort = (): void => {
			reject(new Error("the shop call was aborted", { cause: signal.reason }));
		};
		if (signal.aborted) {
			abort();
		}
		signal.addEventListener("abort", abort, { once: true });
	});
}

/**
 * A shop that has no stock for the orders in `missing` and declines the payment of those in `declined`. Each call
 * waits at `pause` before it does its work and again before it replies, and stops when its signal aborts. The work
 * is keyed by the order, so a second run does nothing more.
 */
function fakeShop(missing: readonly string[], declined: readonly string[], pause: () => Promise<void>): FakeShop {
	const reservations = new Set<Token>();
	const payments = new Set<Token>();
	const work = async (signal: Signal, refused: readonly string[], c: Token, made: Set<Token>): Promise<boolean> => {
		await Promise.race([pause(), untilAborted(signal)]);
		if (typeof c !== "string" || refused.includes(c)) {
			return false;
		}
		made.add(c);
		// The reply is on its way: an abort that lands now cuts off work that was done.
		await Promise.race([pause(), untilAborted(signal)]);
		return true;
	};
	return {
		reserve: (c, _operationId, signal) => work(signal, missing, c, reservations),
		charge: (c, _operationId, signal) => work(signal, declined, c, payments),
		undo: (c) => {
			reservations.delete(c);
			payments.delete(c);
			return Promise.resolve();
		},
		reservations: () => reservations,
		payments: () => payments,
	};
}

function runtimeOf(shop: Shop): Runtime {
	return createRuntime({
		name: "order-process",
		nonce: randomUUID(),
		net: orderProcess,
		policy: definitionOrder,
		clock,
		executions: orderProcessHandlers(shop),
		startLimit: 100,
	});
}

/** The end of each order on `Done`, by order. */
function endings(marking: Marking): ReadonlyMap<string, readonly Token[]> {
	const found = new Map<string, Token[]>();
	for (const token of tokensAt(marking, done.id)) {
		const fields: readonly unknown[] = Array.isArray(token) ? token : [];
		const key = typeof fields[0] === "string" ? fields[0] : "not an order";
		found.set(key, [...(found.get(key) ?? []), String(fields[1])]);
	}
	return found;
}

/** Each order ends once on `Done`, and no other place holds a token: the case completed properly. */
function completedProperly(marking: Marking, orders: readonly string[]): boolean {
	const ends = endings(marking);
	return (
		orders.every((c) => ends.get(c)?.length === 1) &&
		ends.size === orders.length &&
		Object.entries(marking).every(([place, tokens]) => place === done.id || tokens.length === 0)
	);
}

/** How each order ended: `shipped` or `cancelled`, or undefined when it did not end once. */
function endOf(marking: Marking, c: string): Token | undefined {
	const ends = endings(marking).get(c) ?? [];
	return ends.length === 1 ? ends[0] : undefined;
}

type Orders = {
	readonly orders: readonly string[];
	readonly missing: readonly string[];
	readonly declined: readonly string[];
	readonly cancelled: readonly string[];
};

/**
 * A shipped order holds its reservation and its payment; a cancelled one holds neither. An order with missing stock
 * or a declined payment is cancelled. An order that the host did not cancel and the shop did not refuse is shipped.
 */
function shopAgrees(marking: Marking, shop: FakeShop, run: Orders): boolean {
	return run.orders.every((c) => {
		const end = endOf(marking, c);
		return endHeld(end, shop, c) && end === expectedEnd(run, c, end);
	});
}

/** A shipped order holds its reservation and its payment; any other end holds neither. */
function endHeld(end: Token | undefined, shop: FakeShop, c: string): boolean {
	const holds = [shop.reservations().has(c), shop.payments().has(c)];
	return end === "shipped" ? holds.every(Boolean) : !holds.some(Boolean);
}

/** `cancelled` for a refused order, `shipped` for one that nobody stopped, and either for one that the host cancelled. */
function expectedEnd(run: Orders, c: string, end: Token | undefined): Token | undefined {
	if (run.missing.includes(c) || run.declined.includes(c)) {
		return "cancelled";
	}
	return run.cancelled.includes(c) && end === "cancelled" ? "cancelled" : "shipped";
}

/** The host cancels each order in `cancelled` at a time the scheduler chooses: it aborts the order's sides in flight. */
function cancelling(cancelled: readonly string[], scheduler: fc.Scheduler): (instance: NetInstance) => Promise<void> {
	return async (instance) => {
		await Promise.all(
			cancelled.map(async (c) => {
				await scheduler.schedule(Promise.resolve(), `cancel ${c}`);
				while (
					(await instance.inFlight(context)).some(
						(operation) => operation.transition === "Split" && operation.binding.c === c,
					)
				) {
					await flush();
				}
				const sides = (await instance.inFlight(context)).filter(
					(operation) => abortable.has(operation.transition) && operation.binding.c === c,
				);
				await Promise.all(sides.map((operation) => cancelSide(instance, operation.id)));
			}),
		);
	};
}

async function cancelSide(instance: NetInstance, id: string): Promise<void> {
	while ((await instance.abort(id, context)) !== "terminal") await flush();
	if ((await instance.inFlight(context)).some((operation) => operation.id === id)) {
		await instance.resolve(id, { variant: "aborted", value: null }, context);
	}
}

const now = (): Promise<void> => Promise.resolve();

describe("order process", () => {
	test("pre-launch cancellation holds the side tokens without a result until the operator resolves it", async () => {
		const disk = createDisk();
		const shop = fakeShop([], [], now);
		const runtime = createRuntime({
			name: "unlaunched-sides",
			nonce: randomUUID(),
			net: { ...orderProcess, transitions: [] },
			policy: definitionOrder,
			clock,
			executions: orderProcessHandlers(shop),
			startLimit: 3,
		});
		const process = await disk.open(runtime);
		onTestFinished(() => process.close());
		await process.instance.enqueue(
			{
				requestId: "sides",
				tokens: {
					[placeId("ToCheck")]: ["o1"],
					[placeId("ToCharge")]: ["o1"],
				},
			},
			context,
		);
		const sides = await process.instance.inFlight(context);
		expect(sides).toHaveLength(2);
		for (const side of sides) expect(await process.instance.abort(side.id, context)).toBe("marked");
		await process.settle();
		expect(await process.instance.inFlight(context)).toStrictEqual(sides);
		const held = await process.instance.state(context);
		expect(held.log.filter((entry) => entry.kind === "ingress")).toHaveLength(1);
		expect([...shop.reservations(), ...shop.payments()]).toStrictEqual([]);
		for (const side of sides) await process.instance.resolve(side.id, { variant: "aborted", value: null }, context);
		await process.settle();
		expect(tokensAt(disk.last(), done.id)).toStrictEqual([["o1", "cancelled"]]);
		expect(completedProperly(disk.last(), ["o1"])).toBe(true);
	});

	test("ships an order that the shop can serve, and cancels and undoes one whose payment it declines", async () => {
		const disk = createDisk();
		const shop = fakeShop([], ["o2"], now);
		await runToEnd(disk, runtimeOf(shop), initialMarking(["o1", "o2"]), undefined);
		expect(tokensAt(disk.last(), done.id)).toStrictEqual([
			["o1", "shipped"],
			["o2", "cancelled"],
		]);
		expect([...shop.reservations()]).toStrictEqual(["o1"]);
		expect([...shop.payments()]).toStrictEqual(["o1"]);
		expect(completedProperly(disk.last(), ["o1", "o2"])).toBe(true);
	});

	test("an abort that lands after the shop did the work of one side, before its reply, still undoes that work", async () => {
		const disk = createDisk();
		// The pause before the work ends at once, and the pause before the reply never ends: only an abort ends it.
		let pauses = 0;
		const shop = fakeShop([], [], () => {
			pauses += 1;
			return pauses === 1 ? Promise.resolve() : new Promise(() => undefined);
		});
		const cancelAfterWork = async (instance: NetInstance): Promise<void> => {
			while (shop.reservations().size + shop.payments().size === 0) {
				await flush();
			}
			const sides = (await instance.inFlight(context)).filter((operation) => abortable.has(operation.transition));
			await Promise.all(sides.map((operation) => cancelSide(instance, operation.id)));
		};
		await runToEnd(disk, runtimeOf(shop), initialMarking(["o1"]), undefined, undefined, cancelAfterWork);
		expect(tokensAt(disk.last(), done.id)).toStrictEqual([["o1", "cancelled"]]);
		expect([...shop.reservations(), ...shop.payments()]).toStrictEqual([]);
		expect(completedProperly(disk.last(), ["o1"])).toBe(true);
	});

	test("each order ends once and the shop agrees, under any refusals, any order of work, cancels at any time, and a crash at any commit", async () => {
		const someOrders = fc.subarray(["o1", "o2", "o3"]);
		await fc.assert(
			fc.asyncProperty(
				fc.scheduler(),
				fc.record({
					orders: fc.shuffledSubarray(["o1", "o2", "o3"], { minLength: 1 }),
					missing: someOrders,
					declined: someOrders,
					cancelled: someOrders,
				}),
				fc.option(fc.nat({ max: 60 }), { nil: undefined }),
				async (scheduler, run, crashAt) => {
					const disk = createDisk();
					const shop = fakeShop(run.missing, run.declined, () => scheduler.schedule(Promise.resolve(), "shop"));
					await runToEnd(
						disk,
						runtimeOf(shop),
						initialMarking(run.orders),
						crashAt,
						(settling) => scheduler.waitFor(settling),
						cancelling(run.cancelled, scheduler),
					);
					const atMostOnce = disk
						.history()
						.every((marking) => [...endings(marking).values()].every((e) => e.length <= 1));
					return atMostOnce && completedProperly(disk.last(), run.orders) && shopAgrees(disk.last(), shop, run);
				},
			),
		);
	});
});
