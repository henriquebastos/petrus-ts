import fc from "fast-check";
import type { Marking, Place, Token } from "@petrus/petri-net";
import { definitionOrder, tokensAt } from "@petrus/petri-net";
import type { Runtime } from "@petrus/runtime";
import { createRuntime } from "@petrus/runtime";
import { describe, expect, test } from "vitest";
import type { Network, Timer } from "../src/simple-protocol.ts";
import {
	dataReceived,
	initialMarking,
	nextRec,
	nextSend,
	packetsToSend,
	simpleProtocol,
	simpleProtocolHandlers,
} from "../src/simple-protocol.ts";
import type { HistoryDisk } from "./disk.ts";
import { Crashed, historyDisk } from "./disk.ts";
import { flush } from "./flush.ts";

/** The data of the example in Jensen, Kristensen and Wells (2007), section 2. */
const paperData = ["COL", "OUR", "ED ", "PET", "RI ", "NET"];

type FakeNetwork = Network & { readonly transmitted: () => readonly Token[] };

/** A network that loses a message when the next of `losses` is true, and delivers once `losses` runs out. */
function fakeNetwork(losses: readonly boolean[], pause: () => Promise<void>): FakeNetwork {
	const left = [...losses];
	const transmitted: Token[] = [];
	return {
		transmit: async (message) => {
			transmitted.push(message);
			await pause();
			return left.shift() !== true;
		},
		transmitted: () => transmitted,
	};
}

function runtimeOn(disk: HistoryDisk, network: Network, timer: Timer, dieAt?: number): Runtime {
	return createRuntime({
		net: simpleProtocol,
		store: disk.open(dieAt),
		policy: definitionOrder,
		clock: { now: () => 0 },
		handlers: simpleProtocolHandlers(network, timer),
	});
}

/** The one token on a place that always holds one token, or undefined when it holds none or more than one. */
function only(marking: Marking, place: Place): Token | undefined {
	const tokens = tokensAt(marking, place.id);
	return tokens.length === 1 ? tokens[0] : undefined;
}

/** The receiver has the data of the packets before the one it expects, each once and in order. */
function receivedInOrder(marking: Marking, data: readonly string[]): boolean {
	const k = only(marking, nextRec);
	return (
		only(marking, nextSend) !== undefined &&
		typeof k === "number" &&
		only(marking, dataReceived) === data.slice(0, k - 1).join("")
	);
}

/** The places that hold the state of the sender and the receiver when no message or work is left. */
const kept = new Set([packetsToSend, nextSend, nextRec, dataReceived].map((place): string => place.id));

/** All data received and acknowledged, every packet back on `PacketsToSend`, and every other place empty. */
function done(marking: Marking, data: readonly string[]): boolean {
	return (
		only(marking, dataReceived) === data.join("") &&
		only(marking, nextSend) === data.length + 1 &&
		only(marking, nextRec) === data.length + 1 &&
		tokensAt(marking, packetsToSend.id).length === data.length &&
		Object.entries(marking).every(([place, tokens]) => kept.has(place) || tokens.length === 0)
	);
}

const now = (): Promise<void> => Promise.resolve();

describe("simple protocol", () => {
	test("delivers the data of the paper once and in order", async () => {
		const disk = historyDisk({ marking: initialMarking(paperData), log: [] });
		await runtimeOn(disk, fakeNetwork([], now), { wait: now }).settle();
		expect(only(disk.last().marking, dataReceived)).toBe("COLOURED PETRI NET");
		expect(done(disk.last().marking, paperData)).toBe(true);
	});

	test("holds a sent packet until its timer runs out, and then sends it again if the network lost it", async () => {
		const disk = historyDisk({ marking: initialMarking(["COL"]), log: [] });
		const network = fakeNetwork([true], now);
		const timers: (() => void)[] = [];
		const timer: Timer = {
			wait: () =>
				new Promise<void>((resolve) => {
					timers.push(resolve);
				}),
		};
		const settled = runtimeOn(disk, network, timer).settle();
		await flush();
		expect(network.transmitted()).toStrictEqual([[1, "COL"]]);
		expect(only(disk.last().marking, dataReceived)).toBe("");
		timers.shift()?.();
		await flush();
		expect(network.transmitted()).toStrictEqual([[1, "COL"], [1, "COL"], 2]);
		expect(only(disk.last().marking, dataReceived)).toBe("COL");
		expect(timers).toHaveLength(1);
		timers.shift()?.();
		await settled;
		expect(done(disk.last().marking, ["COL"])).toBe(true);
	});

	test("the receiver gets the data once and in order, under any losses, any order of messages and timers, and a crash at any commit", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.scheduler(),
				fc.integer({ min: 1, max: 4 }),
				fc.array(fc.boolean(), { maxLength: 8 }),
				fc.option(fc.nat({ max: 150 }), { nil: undefined }),
				async (scheduler, packets, losses, dieAt) => {
					const data = paperData.slice(0, packets);
					const disk = historyDisk({ marking: initialMarking(data), log: [] });
					const network = fakeNetwork(losses, () => scheduler.schedule(Promise.resolve(), "network"));
					const timer: Timer = { wait: () => scheduler.schedule(Promise.resolve(), "timer") };
					await scheduler.waitFor(runtimeOn(disk, network, timer, dieAt).settle()).catch((error: unknown) => {
						if (!(error instanceof Crashed)) {
							throw error;
						}
						return scheduler.waitFor(runtimeOn(disk, network, timer).settle());
					});
					return (
						disk.history().every((state) => receivedInOrder(state.marking, data)) &&
						done(disk.last().marking, data)
					);
				},
			),
		);
	});
});
