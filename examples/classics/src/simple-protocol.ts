import { defineTask } from "@earendil-works/pi-durable";
import type { Binding, ColourSet, Marking, Net, Place, Token, Transition } from "@petrus/petri-net";
import { placeId, transitionId } from "@petrus/petri-net";
import type { Execution, ExecutionInput, HandlerResult, HandlerTransition } from "@petrus/runtime";
import { execution } from "@petrus/runtime";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { abortNative, completeNative } from "./native-outcome.ts";

/**
 * A sender sends numbered packets to a receiver over a network that can lose packets and acknowledgements, and
 * deliver them in any order. The sender sends the packet that `nextSend` names until an acknowledgement moves
 * `nextSend` on. The receiver keeps only the packet it expects, and acknowledges each packet it gets with the
 * number of the packet it expects next. So the receiver gets the data once and in order.
 *
 * The network's two transmissions and the retransmission timer are work outside the net, so they are handlers.
 * The network's result is a variant: `delivered` or `lost`. The timer takes a sent packet from `sent` and holds it
 * off `packetsToSend` until its wait ends, so the sender sends a packet again only after a wait. Its result is
 * delayed, so the wait is a Durable sleep and survives a crash.
 */
const sequenceNumber: ColourSet = { name: "NO", contains: (token) => Number.isInteger(token) };
const text: ColourSet = { name: "DATA", contains: (token) => typeof token === "string" };
const packet: ColourSet = {
	name: "NOxDATA",
	contains: (token) =>
		Array.isArray(token) && token.length === 2 && Number.isInteger(token[0]) && typeof token[1] === "string",
};

/** The packets of the data, each always there to be sent again except while its timer runs. */
export const packetsToSend: Place = { id: placeId("PacketsToSend"), colourSet: packet };
/** The number of the packet that the sender sends. */
export const nextSend: Place = { id: placeId("NextSend"), colourSet: sequenceNumber };
/** Packets sent, before the network. */
const a: Place = { id: placeId("A"), colourSet: packet };
/** Packets that the network delivered to the receiver. */
const b: Place = { id: placeId("B"), colourSet: packet };
/** Acknowledgements sent, before the network. */
const c: Place = { id: placeId("C"), colourSet: sequenceNumber };
/** Acknowledgements that the network delivered to the sender. */
const d: Place = { id: placeId("D"), colourSet: sequenceNumber };
/** The data that the receiver has, and the number of the packet it expects next. */
export const dataReceived: Place = { id: placeId("DataReceived"), colourSet: text };
export const nextRec: Place = { id: placeId("NextRec"), colourSet: sequenceNumber };
/** Sent packets whose retransmission timer has not started. This place is not in the paper. */
const sent: Place = { id: placeId("Sent"), colourSet: packet };

/** The number of a packet token, or NaN for another token. */
function numberOf(token: Token): number {
	return Array.isArray(token) && typeof token[0] === "number" ? token[0] : Number.NaN;
}

/** The data of a packet token, or "" for another token. */
function dataOf(token: Token): string {
	return Array.isArray(token) && typeof token[1] === "string" ? token[1] : "";
}

/** Sends the packet that `nextSend` names, and starts its timer. */
const sendPacket: Transition<"n" | "packet"> = {
	id: transitionId("SendPacket"),
	variables: { n: sequenceNumber, packet },
	guard: ({ n, packet: sending }) => numberOf(sending) === n,
	inputs: [
		{ place: nextSend, variables: ["n"] },
		{ place: packetsToSend, variables: ["packet"] },
	],
	outputs: [
		{ place: nextSend, expression: ({ n }) => [n] },
		{ place: a, expression: ({ packet: sending }) => [sending] },
		{ place: sent, expression: ({ packet: sending }) => [sending] },
	],
};

/** Keeps the packet if it is the one expected, and acknowledges it with the number expected next. */
const receivePacket: Transition<"packet" | "k" | "data"> = {
	id: transitionId("ReceivePacket"),
	variables: { packet, k: sequenceNumber, data: text },
	guard: () => true,
	inputs: [
		{ place: b, variables: ["packet"] },
		{ place: nextRec, variables: ["k"] },
		{ place: dataReceived, variables: ["data"] },
	],
	outputs: [
		{ place: dataReceived, expression: ({ packet: got, k, data }) => [received(got, k, data)] },
		{ place: nextRec, expression: ({ packet: got, k }) => [next(got, k)] },
		{ place: c, expression: ({ packet: got, k }) => [next(got, k)] },
	],
};

/** True when the packet is the one that the receiver expects, number `k`. */
function isExpected(got: Token, k: Token): boolean {
	return numberOf(got) === k;
}

/** The data with the packet's data added when it is the packet expected. */
function received(got: Token, k: Token, data: Token): Token {
	return isExpected(got, k) && typeof data === "string" ? `${data}${dataOf(got)}` : data;
}

/** The number of the packet that the receiver expects after it gets this packet. */
function next(got: Token, k: Token): Token {
	return isExpected(got, k) ? Number(k) + 1 : k;
}

/** Moves `nextSend` to the number that the acknowledgement names. */
const receiveAck: Transition<"ack" | "n"> = {
	id: transitionId("ReceiveAck"),
	variables: { ack: sequenceNumber, n: sequenceNumber },
	guard: () => true,
	inputs: [
		{ place: d, variables: ["ack"] },
		{ place: nextSend, variables: ["n"] },
	],
	outputs: [{ place: nextSend, expression: ({ ack }) => [ack] }],
};

/** The network takes a packet from `A`, and delivers it to `B` or loses it. */
const transmitPacket: HandlerTransition<"packet"> = {
	id: transitionId("TransmitPacket"),
	variables: { packet },
	guard: () => true,
	inputs: [{ place: a, variables: ["packet"] }],
	variants: {
		delivered: { value: packet, outputs: [{ place: b, expression: ({ packet: moving }) => [moving] }] },
		lost: { value: packet, outputs: [] },
	},
};

/** The network takes an acknowledgement from `C`, and delivers it to `D` or loses it. */
const transmitAck: HandlerTransition<"ack"> = {
	id: transitionId("TransmitAck"),
	variables: { ack: sequenceNumber },
	guard: () => true,
	inputs: [{ place: c, variables: ["ack"] }],
	variants: {
		delivered: { value: sequenceNumber, outputs: [{ place: d, expression: ({ ack }) => [ack] }] },
		lost: { value: sequenceNumber, outputs: [] },
	},
};

/** The retransmission timer. When it runs out, the packet is on `packetsToSend` again. */
const wait: HandlerTransition<"packet"> = {
	id: transitionId("Wait"),
	variables: { packet },
	guard: () => true,
	inputs: [{ place: sent, variables: ["packet"] }],
	variants: {
		elapsed: { value: packet, outputs: [{ place: packetsToSend, expression: ({ packet: waited }) => [waited] }] },
	},
};

/** The net without its handler transitions; the runtime adds them from `simpleProtocolHandlers`. */
export const simpleProtocol: Net = {
	places: [packetsToSend, nextSend, a, b, c, d, dataReceived, nextRec, sent],
	transitions: [sendPacket, receivePacket, receiveAck],
};

/** The data to send, as numbered packets from 1; nothing received yet, and packet 1 expected and sent next. */
export function initialMarking(data: readonly string[]): Marking {
	return {
		[packetsToSend.id]: data.map((part, index): Token => [index + 1, part]),
		[nextSend.id]: [1],
		[nextRec.id]: [1],
		[dataReceived.id]: [""],
	};
}

/** The network outside the net. `transmit` is true when it delivers. */
export type Network = { readonly transmit: (message: Token, operationId: string) => Promise<boolean> };

const packetBinding = Type.Object({ packet: Type.Tuple([Type.Integer(), Type.String()]) });
type TimerState = { readonly phase: "wait" } | { readonly phase: "elapsed"; readonly packet: Token };

/** The handlers of the net: the network's two transmissions, and a timer that waits `waitMs` after each send. */
export function simpleProtocolHandlers(network: Network, waitMs: number): readonly Execution[] {
	if (!Number.isFinite(waitMs) || waitMs < 0) throw new RangeError("waitMs must be finite and nonnegative");
	const timeout = defineTask<ExecutionInput, TimerState, HandlerResult>({
		name: "classics:protocol-wait",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async ({ input }, runtime, context) => {
				const { packet } = Value.Parse(packetBinding, input.binding);
				await runtime.sleepUntil(input.startedAt + waitMs, { phase: "elapsed", packet }, context);
			},
			elapsed: async ({ state }, runtime, context) => {
				await completeNative(runtime, context, { variant: "elapsed", value: state.checkpoint.packet });
			},
		},
		abort: abortNative,
	});
	return [
		transmission(transmitPacket, (binding) => Value.Parse(packetBinding, binding).packet, network),
		transmission(transmitAck, (binding) => Value.Parse(Type.Object({ ack: Type.Integer() }), binding).ack, network),
		execution(wait, timeout),
	];
}

function transmission(
	transition: HandlerTransition,
	message: (binding: Binding) => Token,
	network: Network,
): Execution {
	const task = defineTask<ExecutionInput, { readonly phase: "transmit" }, HandlerResult>({
		name: `classics:${transition.id}`,
		version: 1,
		initial: () => ({ phase: "transmit" }),
		phases: {
			transmit: async ({ input }, runtime, context) => {
				const value = message(input.binding);
				const variant = (await network.transmit(value, input.id)) ? "delivered" : "lost";
				await completeNative(runtime, context, { variant, value });
			},
		},
		abort: abortNative,
	});
	return execution(transition, task);
}
