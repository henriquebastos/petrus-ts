import { randomUUID } from "node:crypto";
import fc from "fast-check";
import type { InputArc, Marking, Token, Transition } from "@petrus/petri-net";
import { definitionOrder, enabledBindings, tokenKey, tokensAt, transitionId } from "@petrus/petri-net";
import type { Runtime } from "@petrus/runtime";
import { busyPlaceId, createRuntime } from "@petrus/runtime";
import { describe, expect, onTestFinished, test } from "vitest";
import type { Table } from "../src/dining-philosophers.ts";
import {
	diningPhilosophers,
	diningPhilosophersHandlers,
	fed,
	forks,
	hungry,
	initialMarking,
	leftFork,
	seat,
} from "../src/dining-philosophers.ts";
import { clock, context, createDisk, runToEnd } from "./disk.ts";
import { flush } from "./flush.ts";

const eating = busyPlaceId(transitionId("eat"));

type SharedTable = Table & {
	/** Each time two neighbours ate at once: their operation ids. */
	readonly overlaps: () => readonly (readonly string[])[];
	/** The philosopher of each meal that ended, by operation id. */
	readonly meals: () => ReadonlyMap<string, Token>;
	/** The philosophers in the order their meals ended. */
	readonly ended: () => readonly Token[];
	/** The philosophers eating now, in the order they sat down. */
	readonly atTable: () => readonly Token[];
};

function neighbours(first: Token, second: Token, size: number): boolean {
	const distance = (seat(first) - seat(second) + size) % size;
	return distance === 1 || distance === size - 1;
}

/** A table that records when two neighbours eat at once. A meal is an operation, so a second run of one is the same meal. */
function sharedTable(size: number, pause: (philosopher: Token) => Promise<void>): SharedTable {
	const atTable = new Map<string, Token>();
	const overlaps: string[][] = [];
	const meals = new Map<string, Token>();
	const ended: Token[] = [];
	const sit = (philosopher: Token, operationId: string): void => {
		const beside = [...atTable].filter(([id, other]) => id !== operationId && neighbours(philosopher, other, size));
		overlaps.push(...beside.map(([id]) => [id, operationId]));
		atTable.set(operationId, philosopher);
	};
	return {
		eat: async (philosopher, operationId) => {
			sit(philosopher, operationId);
			await pause(philosopher);
			atTable.delete(operationId);
			meals.set(operationId, philosopher);
			ended.push(philosopher);
		},
		overlaps: () => overlaps,
		meals: () => meals,
		ended: () => ended,
		atTable: () => [...atTable.values()],
	};
}

function runtimeOf(size: number, table: Table): Runtime {
	return createRuntime({
		name: "dining-philosophers",
		nonce: randomUUID(),
		net: diningPhilosophers,
		policy: definitionOrder,
		clock,
		executions: diningPhilosophersHandlers(size, table),
		startLimit: 100,
	});
}

function sortedKeys(tokens: readonly Token[]): string {
	return JSON.stringify(tokens.map(tokenKey).sort());
}

function isList(token: Token): token is readonly Token[] {
	return Array.isArray(token);
}

/** A variable of a meal's binding, read from its token on `eat:busy`. */
function bound(binding: Token, variable: string): Token {
	if (typeof binding !== "object" || binding === null || isList(binding)) {
		return null;
	}
	return binding[variable] ?? null;
}

/** Each fork is on the table or in the hands of one eating philosopher, so no two neighbours eat at once. */
function eachForkOnce(marking: Marking, size: number): boolean {
	const all = [
		...tokensAt(marking, forks.id),
		...tokensAt(marking, eating).flatMap((binding) => {
			const diner = seat(bound(binding, "philosopher"));
			return [leftFork(diner), leftFork((diner + 1) % size)];
		}),
	];
	return sortedKeys(all) === sortedKeys(Array.from({ length: size }, (_, index) => leftFork(index)));
}

function diners(marking: Marking): readonly Token[] {
	return tokensAt(marking, eating).map((binding) => bound(binding, "philosopher"));
}

/** The `eat` transition of a table of `size`, whose forks arc records the philosopher of each run. */
function countedEat(size: number, computed: Token[]): Transition {
	const [meal] = diningPhilosophersHandlers(
		size,
		sharedTable(size, () => Promise.resolve()),
	);
	if (meal === undefined) {
		throw new Error("the table has no eat handler");
	}
	const inputs = meal.transition.inputs.map((arc): InputArc => {
		if (arc.variables !== undefined) {
			return arc;
		}
		return {
			place: arc.place,
			expression: (binding) => {
				computed.push(binding.philosopher ?? null);
				return arc.expression(binding);
			},
		};
	});
	return { ...meal.transition, inputs, outputs: [] };
}

describe("dining philosophers", () => {
	test("computes the forks once for each distinct hungry philosopher in one enabledBindings call", () => {
		const size = 40;
		const seats = Array.from({ length: size }, (_, index) => `p${String(index)}`);
		const computed: Token[] = [];
		const enabled = enabledBindings(countedEat(size, computed), initialMarking(size, [...seats, "p7", "p0", "p7"]));
		expect(enabled).toStrictEqual(seats.map((diner) => ({ philosopher: diner })));
		expect(computed).toStrictEqual(seats);
	});

	test("lets philosophers who are not neighbours eat in the same step, and gives every fork back", async () => {
		const meals = ["p0", "p1", "p2", "p3", "p4"];
		const disk = createDisk();
		const table = sharedTable(5, () => Promise.resolve());
		await runToEnd(disk, runtimeOf(5, table), initialMarking(5, meals), undefined);
		expect(diners(disk.history()[0] ?? {})).toStrictEqual(["p0", "p2"]);
		expect(sortedKeys(tokensAt(disk.last(), fed.id))).toBe(sortedKeys(meals));
		expect(sortedKeys(tokensAt(disk.last(), forks.id))).toBe(sortedKeys(["f0", "f1", "f2", "f3", "f4"]));
		expect(tokensAt(disk.last(), hungry.id)).toStrictEqual([]);
		expect(table.overlaps()).toStrictEqual([]);
	});

	test("never lets two neighbours eat at once and leaves no one hungry, under any order of meals and a crash at any commit", async () => {
		const table = fc.integer({ min: 2, max: 5 }).chain((size) =>
			fc.record({
				size: fc.constant(size),
				seats: fc.array(fc.nat({ max: size - 1 }), { minLength: 1, maxLength: 6 }),
			}),
		);
		await fc.assert(
			fc.asyncProperty(
				fc.scheduler(),
				table,
				fc.option(fc.nat({ max: 16 }), { nil: undefined }),
				async (scheduler, { size, seats }, crashAt) => {
					const meals = seats.map((index) => `p${String(index)}`);
					const disk = createDisk();
					const shared = sharedTable(size, () => scheduler.schedule(Promise.resolve(), "meal"));
					await runToEnd(disk, runtimeOf(size, shared), initialMarking(size, meals), crashAt, (settling) =>
						scheduler.waitFor(settling),
					);
					return (
						disk.history().every((state) => eachForkOnce(state, size)) &&
						shared.overlaps().length === 0 &&
						tokensAt(disk.last(), hungry.id).length === 0 &&
						sortedKeys(tokensAt(disk.last(), fed.id)) === sortedKeys(meals) &&
						sortedKeys([...shared.meals().values()]) === sortedKeys(meals)
					);
				},
			),
		);
	});

	test("lets a philosopher starve while both neighbours take turns, because definitionOrder keeps no state", async () => {
		const meals = ["p0", "p1", "p2", "p3", "p0", "p2", "p0", "p2"];
		const disk = createDisk();
		const waiting: (() => void)[] = [];
		const table = sharedTable(
			4,
			() =>
				new Promise<void>((resolve) => {
					waiting.push(resolve);
				}),
		);
		const process = await disk.open(runtimeOf(4, table));
		onTestFinished(() => process.close());
		await process.instance.enqueue({ requestId: "first", tokens: initialMarking(4, meals) }, context);
		const settled = process.settle();
		const seen: (readonly Token[])[] = [];
		for (const _meal of meals) {
			await flush();
			seen.push(table.atTable());
			const endMeal = waiting.shift();
			expect(endMeal).toBeDefined();
			endMeal?.();
		}
		await settled;
		expect(seen).toStrictEqual([
			["p0", "p2"],
			["p2", "p0"],
			["p0", "p2"],
			["p2", "p0"],
			["p0", "p2"],
			["p2"],
			["p1", "p3"],
			["p3"],
		]);
		expect(table.ended()).toStrictEqual(["p0", "p2", "p0", "p2", "p0", "p2", "p1", "p3"]);
	});
});
