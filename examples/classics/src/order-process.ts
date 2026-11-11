import type { ColourSet, Marking, Net, Place, Token, Transition } from "@petrus/petri-net";
import { placeId, transitionId } from "@petrus/petri-net";
import type { Handler, HandlerTransition, Signal } from "@petrus/runtime";

/** The two fields of a pair token, or none when the token is not a pair. */
function fields(token: Token): readonly unknown[] {
	return Array.isArray(token) && token.length === 2 ? token : [];
}

function isOrder(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

/**
 * An order process as a workflow net (van der Aalst, 1998). Each order is a case: its tokens carry the order's id,
 * which must name one case only.
 * A split starts two handlers at once: `CheckStock` reserves the goods, and `Charge` takes the payment. The join
 * `Ship` fires when both succeeded. Otherwise the handler `Undo` releases the reservation and refunds the payment,
 * if they were made, and the order ends cancelled. Each order ends with one token on `Done`.
 *
 * The host cancels an order by aborting its operations in flight. An aborted side counts as failed, but its work may
 * have been done before the abort landed. So `Undo` asks the shop to undo both sides, whatever their variants said.
 */
const order: ColourSet = { name: "ORDER", contains: isOrder };
const outcome: ColourSet = {
	name: "ORDER x BOOL",
	contains: (token) => isOrder(fields(token)[0]) && typeof fields(token)[1] === "boolean",
};
const ending: ColourSet = {
	name: "ORDER x END",
	contains: (token) => isOrder(fields(token)[0]) && ["shipped", "cancelled"].includes(String(fields(token)[1])),
};
const unit: ColourSet = { name: "UNIT", contains: (token) => token === null };

/** Orders that the host put in. */
const received: Place = { id: placeId("Received"), colourSet: order };
const toCheck: Place = { id: placeId("ToCheck"), colourSet: order };
const toCharge: Place = { id: placeId("ToCharge"), colourSet: order };
/** Whether the stock of an order is reserved: `[order, true]`, or `[order, false]` when it is missing or aborted. */
const stocked: Place = { id: placeId("Stocked"), colourSet: outcome };
/** Whether an order is paid: `[order, true]`, or `[order, false]` when the payment was declined or aborted. */
const billed: Place = { id: placeId("Billed"), colourSet: outcome };
/** The end of each order: `[order, "shipped"]` or `[order, "cancelled"]`. */
export const done: Place = { id: placeId("Done"), colourSet: ending };

/** The order of an outcome token, or undefined when the token is not one. */
function orderOf(token: Token): string | undefined {
	const [c] = fields(token);
	return isOrder(c) ? c : undefined;
}

function succeeded(token: Token): boolean {
	return fields(token)[1] === true;
}

/** True when the two outcomes are of the same order. */
function sameOrder(s: Token, b: Token): boolean {
	return orderOf(s) !== undefined && orderOf(s) === orderOf(b);
}

/** Starts both sides of an order at once (a parallel split). */
const split: Transition<"c"> = {
	id: transitionId("Split"),
	variables: { c: order },
	guard: () => true,
	inputs: [{ place: received, variables: ["c"] }],
	outputs: [
		{ place: toCheck, expression: ({ c }) => [c] },
		{ place: toCharge, expression: ({ c }) => [c] },
	],
};

/** A side of the order: work that succeeds, fails, or is aborted. Each end puts the order's outcome on `place`. */
function side(id: string, from: Place, place: Place, ok: string, failed: string): HandlerTransition<"c"> {
	const outcomeIs =
		(value: boolean) =>
		({ c }: { readonly c: Token }): readonly Token[] => [[c, value]];
	return {
		id: transitionId(id),
		variables: { c: order },
		guard: () => true,
		inputs: [{ place: from, variables: ["c"] }],
		variants: {
			[ok]: { value: order, outputs: [{ place, expression: outcomeIs(true) }] },
			[failed]: { value: order, outputs: [{ place, expression: outcomeIs(false) }] },
			aborted: { value: unit, outputs: [{ place, expression: outcomeIs(false) }] },
		},
	};
}

const checkStock = side("CheckStock", toCheck, stocked, "reserved", "missing");
const charge = side("Charge", toCharge, billed, "charged", "declined");

function orderKey(token: Token): string {
	return orderOf(token) ?? "";
}

const joinKeys = { s: orderKey, b: orderKey };

/** Ships an order whose stock is reserved and whose payment is taken (the join). */
const ship: Transition<"s" | "b"> = {
	id: transitionId("Ship"),
	variables: { s: outcome, b: outcome },
	guard: ({ s, b }) => sameOrder(s, b) && succeeded(s) && succeeded(b),
	joinKeys,
	inputs: [
		{ place: stocked, variables: ["s"] },
		{ place: billed, variables: ["b"] },
	],
	outputs: [{ place: done, expression: ({ s }) => [[orderOf(s) ?? null, "shipped"]] }],
};

/** Undoes both sides of an order where one side did not succeed, and ends it cancelled. */
const undo: HandlerTransition<"s" | "b"> = {
	id: transitionId("Undo"),
	variables: { s: outcome, b: outcome },
	guard: ({ s, b }) => sameOrder(s, b) && !(succeeded(s) && succeeded(b)),
	joinKeys,
	inputs: [
		{ place: stocked, variables: ["s"] },
		{ place: billed, variables: ["b"] },
	],
	variants: { undone: { value: order, outputs: [{ place: done, expression: (_binding, c) => [[c, "cancelled"]] }] } },
};

/** The net without its handler transitions; the runtime adds them from `orderProcessHandlers`. */
export const orderProcess: Net = {
	places: [received, toCheck, toCharge, stocked, billed, done],
	transitions: [split, ship],
};

/** The orders to process, on `Received`. */
export function initialMarking(orders: readonly string[]): Marking {
	return { [received.id]: orders };
}

/**
 * The shop outside the net. `reserve` and `charge` are true when they succeed; both stop when `signal` aborts.
 * `undo` releases the order's reservation and refunds its payment, those that were made; a second call does nothing.
 * Each call gets the operation id, so a second run of the same work finds what the first did.
 */
export type Shop = {
	readonly reserve: (order: Token, operationId: string, signal: Signal) => Promise<boolean>;
	readonly charge: (order: Token, operationId: string, signal: Signal) => Promise<boolean>;
	readonly undo: (order: Token, operationId: string) => Promise<void>;
};

export function orderProcessHandlers(shop: Shop): readonly Handler[] {
	const reserving: Handler<"c"> = {
		transition: checkStock,
		run: async ({ c }, { operationId, signal }) => ({
			variant: (await shop.reserve(c, operationId, signal)) ? "reserved" : "missing",
			value: c,
		}),
	};
	const charging: Handler<"c"> = {
		transition: charge,
		run: async ({ c }, { operationId, signal }) => ({
			variant: (await shop.charge(c, operationId, signal)) ? "charged" : "declined",
			value: c,
		}),
	};
	const undoing: Handler<"s" | "b"> = {
		transition: undo,
		run: async ({ s }, { operationId }) => {
			const c = orderOf(s) ?? null;
			await shop.undo(c, operationId);
			return { variant: "undone", value: c };
		},
	};
	return [reserving, charging, undoing];
}

/** The handler transitions that the host may abort: the two sides of an order. */
export const abortable: ReadonlySet<string> = new Set([checkStock.id, charge.id]);
