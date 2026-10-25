import fc from "fast-check";
import type { Marking, Place, Token } from "@petrus/petri-net";
import { definitionOrder, tokensAt } from "@petrus/petri-net";
import type { Runtime } from "@petrus/runtime";
import { createRuntime } from "@petrus/runtime";
import { describe, expect, onTestFinished, test } from "vitest";
import type { Network } from "../src/simple-protocol.ts";
import {
	dataReceived,
	initialMarking,
	nextRec,
	nextSend,
	packetsToSend,
	simpleProtocol,
	simpleProtocolHandlers,
} from "../src/simple-protocol.ts";
import { clock, context, createDisk, runToEnd } from "./disk.ts";

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

/** How long the timer of a sent packet waits. */
const waitMs = 10;

function runtimeOf(network: Network): Runtime {
	return createRuntime({
		name: "simple-protocol",
		net: simpleProtocol,
		policy: definitionOrder,
		clock,
		handlers: simpleProtocolHandlers(network, waitMs),
		retryDelayMs: 0,
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

/** The property below takes about 5 s with coverage, so the default timeout of 5 s fails it under load. */
const propertyTimeoutMs = 30_000;

describe("simple protocol", () => {
	test("delivers the data of the paper once and in order", async () => {
		const disk = createDisk();
		await runToEnd(disk, runtimeOf(fakeNetwork([], now)), initialMarking(paperData), undefined);
		expect(only(disk.last(), dataReceived)).toBe("COLOURED PETRI NET");
		expect(done(disk.last(), paperData)).toBe(true);
	});

	test("sends a lost packet again when the wait of its timer ends, and not before", async () => {
		const disk = createDisk();
		const network = fakeNetwork([true], now);
		const process = await disk.open(runtimeOf(network));
		onTestFinished(() => process.close());
		const start = clock.now();
		await process.instance.enqueue({ requestId: "first", tokens: initialMarking(["COL"]) }, context);
		await process.settle();
		expect(network.transmitted()).toStrictEqual([[1, "COL"], [1, "COL"], 2]);
		const { log } = await process.instance.state(context);
		const sends = log.flatMap((entry) =>
			entry.kind === "occurrence" && entry.transition === "SendPacket" ? [entry.at - start] : [],
		);
		expect(sends).toStrictEqual([0, waitMs]);
		expect(done(disk.last(), ["COL"])).toBe(true);
	});

	test("the receiver gets the data once and in order, under any losses, any order of messages and timer ends, and a crash at any commit", {
		timeout: propertyTimeoutMs,
	}, async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.scheduler(),
				fc.integer({ min: 1, max: 4 }),
				fc.array(fc.boolean(), { maxLength: 8 }),
				fc.option(fc.nat({ max: 100 }), { nil: undefined }),
				async (scheduler, packets, losses, crashAt) => {
					const data = paperData.slice(0, packets);
					const disk = createDisk(() => scheduler.schedule(Promise.resolve(), "clock"));
					const network = fakeNetwork(losses, () => scheduler.schedule(Promise.resolve(), "network"));
					await runToEnd(disk, runtimeOf(network), initialMarking(data), crashAt, (settling) =>
						scheduler.waitFor(settling),
					);
					return disk.history().every((state) => receivedInOrder(state, data)) && done(disk.last(), data);
				},
			),
		);
	});
});
