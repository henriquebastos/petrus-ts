import type { Context } from "@earendil-works/chord";
import type { Binding, ColourSet, Net, Place, PlaceId, Token, Transition, TransitionId } from "@petrus/petri-net";
import { bindingProblems, placeId, tokenKey, transitionId } from "@petrus/petri-net";

/** What a handler returns: the variant it chose and a value of that variant's colour set. */
export type HandlerResult = { readonly variant: string; readonly value: Token };

/** An output arc of a variant. Its expression reads the binding that started the work and the result's value. */
export type ResultArc<V extends string = string> = {
	readonly place: Place;
	readonly expression: (binding: Binding<V>, value: Token) => readonly Token[];
};

/** One way the work can end: the colour set of the result's value, and the arcs that produce the outputs. */
export type Variant<V extends string = string> = {
	readonly value: ColourSet;
	readonly outputs: readonly ResultArc<V>[];
};

/**
 * A transition whose outputs come from outside the net. A binding of it fires as usual and starts work that a
 * handler does outside the net. The handler's result names one variant, and that variant's arcs produce the outputs.
 * Until then the input tokens stay taken, so a resource token is held for the whole work.
 */
export type HandlerTransition<V extends string = string> = Omit<Transition<V>, "outputs"> & {
	readonly variants: Readonly<Record<string, Variant<V>>>;
};

/**
 * A result that counts `delayMs` after the occurrence that started the work, as the delay `@+delayMs` of a timed net.
 * Until then the operation stays in flight. The wait is a Durable sleep, so it survives a crash.
 */
export type DelayedResult = { readonly delayMs: number; readonly result: HandlerResult };

/**
 * What a handler gets besides the binding. `operationId` names this run of the work (see `Operation`). `signal`
 * aborts when the host aborts the operation or the Harness closes: the handler then stops its work, as the abort
 * waits until the run ends.
 */
export type HandlerContext = { readonly operationId: string; readonly signal: Signal };

/**
 * The standard `AbortSignal`. It is named through Chord's `Context`, because api-extractor cannot follow the global
 * type that `@types/node` declares.
 */
export type Signal = NonNullable<Context["abortSignal"]>;

/**
 * The variant that an aborted operation ends with. A handler transition that declares it gets the result
 * `{ variant: "aborted", value: null }` when the host aborts the operation, so its arcs can give the tokens back.
 */
export const abortedVariant = "aborted";

/** True when the handler transition declares the variant `aborted`, so its operations can be aborted. */
export function declaresAborted(transition: HandlerTransition): boolean {
	return Object.hasOwn(transition.variants, abortedVariant);
}

/**
 * Why the handler transitions break the handler rules: an `aborted` variant whose colour set does not hold `null`,
 * the value of an aborted result. An empty list means none does.
 */
export function handlerProblems(transitions: readonly HandlerTransition[]): readonly string[] {
	return transitions
		.filter((transition) => transition.variants[abortedVariant]?.value.contains(null) === false)
		.map((transition) => `${transition.id}: the colour set of the variant aborted must hold null`);
}

/**
 * A handler transition with the function that does its work outside the net. `run` returns an expected failure as a
 * variant, and a result that counts later as a delayed result. It throws only for a bug or an outage; then the
 * operation stays in flight and runs again.
 */
export type Handler<V extends string = string> = {
	readonly transition: HandlerTransition<V>;
	readonly run: (binding: Binding<V>, context: HandlerContext) => Promise<HandlerResult | DelayedResult>;
};

/** The place that holds one token, the binding, for each run of the handler transition that has not ended. */
export function busyPlaceId(transition: TransitionId): PlaceId {
	return placeId(`${transition}:busy`);
}

/** The place where a handler's result waits for its variant to fire. */
export function resultPlaceId(transition: TransitionId): PlaceId {
	return placeId(`${transition}:result`);
}

/** The token that records a handler's result for the run that `binding` started. */
export function resultToken(binding: Binding, result: HandlerResult): Token {
	return { binding, variant: result.variant, value: result.value };
}

/**
 * The plain coloured net that `net` with the handler transitions is short for. Each handler transition `t` becomes:
 * - the transition `t`, with the same variables, guard and inputs, whose output puts the binding on `t:busy`;
 * - the place `t:result`, where the runtime puts the result token (see `resultToken`);
 * - for each variant `v`, the transition `t:v`, which takes a binding from `t:busy` and its result with variant `v`
 *   from `t:result`, and produces the variant's outputs.
 * So the checks and the replay of a plain net hold for a net with handlers.
 */
export function withHandlers(net: Net, transitions: readonly HandlerTransition[]): Net {
	const parts = transitions.map(expand);
	return {
		places: [...net.places, ...parts.flatMap((part) => part.places)],
		transitions: [...net.transitions, ...parts.flatMap((part) => part.transitions)],
	};
}

type Parts = { readonly places: readonly Place[]; readonly transitions: readonly Transition[] };

function expand(handler: HandlerTransition): Parts {
	const busy: Place = {
		id: busyPlaceId(handler.id),
		colourSet: { name: `${handler.id} binding`, contains: (token) => isBindingOf(handler, token) },
	};
	const result: Place = {
		id: resultPlaceId(handler.id),
		colourSet: { name: `${handler.id} result`, contains: (token) => parseResult(handler, token) !== undefined },
	};
	const start: Transition = {
		id: handler.id,
		variables: handler.variables,
		guard: handler.guard,
		inputs: handler.inputs,
		outputs: [{ place: busy, expression: (binding) => [binding] }],
	};
	const ends = Object.entries(handler.variants).map(([name, variant]) => end(handler, name, variant, busy, result));
	return { places: [busy, result], transitions: [start, ...ends] };
}

function end(
	handler: HandlerTransition,
	name: string,
	variant: Variant,
	busy: Place,
	result: Place,
): Transition<"busy" | "result"> {
	return {
		id: transitionId(`${handler.id}:${name}`),
		variables: { busy: busy.colourSet, result: result.colourSet },
		guard: ({ busy: started, result: ended }) => endsRun(handler, name, started, ended),
		inputs: [
			{ place: busy, variables: ["busy"] },
			{ place: result, variables: ["result"] },
		],
		outputs: variant.outputs.map((arc) => ({
			place: arc.place,
			expression: ({ busy: started, result: ended }) =>
				arc.expression(asBinding(handler, started), resultOf(handler, ended).value),
		})),
	};
}

type ParsedResult = { readonly binding: Binding; readonly variant: string; readonly value: Token };

/** True when `ended` is a result with variant `name` for the run whose binding is `started`. */
function endsRun(handler: HandlerTransition, name: string, started: Token, ended: Token): boolean {
	const parsed = parseResult(handler, ended);
	return parsed?.variant === name && tokenKey(parsed.binding) === tokenKey(started);
}

function isBindingOf(handler: HandlerTransition, token: Token): token is Binding {
	return isRecord(token) && bindingProblems({ ...handler, outputs: [] }, token).length === 0;
}

/** The fields of a result token of `handler`, or `undefined` when `token` is not one. */
function parseResult(handler: HandlerTransition, token: Token): ParsedResult | undefined {
	const fields = resultFields(token);
	return fields !== undefined &&
		isBindingOf(handler, fields.binding) &&
		declares(handler, fields.variant, fields.value)
		? { binding: fields.binding, variant: fields.variant, value: fields.value }
		: undefined;
}

type ResultFields = { readonly binding: Token; readonly variant: string; readonly value: Token };

const resultKeys = tokenKey(["binding", "value", "variant"]);

/** The three fields of a result token, not yet checked against the handler, or `undefined` when it has other keys. */
function resultFields(token: Token): ResultFields | undefined {
	return isRecord(token) && tokenKey(Object.keys(token).sort()) === resultKeys ? withNamedVariant(token) : undefined;
}

function withNamedVariant(fields: Readonly<Record<string, Token>>): ResultFields | undefined {
	const { binding = null, variant = null, value = null } = fields;
	return typeof variant === "string" ? { binding, variant, value } : undefined;
}

function declares(handler: HandlerTransition, variant: string, value: Token): boolean {
	return Object.entries(handler.variants).some(
		([name, declared]) => name === variant && declared.value.contains(value),
	);
}

function isRecord(token: Token): token is Readonly<Record<string, Token>> {
	return typeof token === "object" && token !== null && !Array.isArray(token);
}

/** An arc expression gets only tokens of its places' colour sets, so anything else is a bug in the runtime. */
function asBinding(handler: HandlerTransition, token: Token): Binding {
	if (!isBindingOf(handler, token)) {
		throw new TypeError(`${handler.id}: ${tokenKey(token)} is not a binding`);
	}
	return token;
}

function resultOf(handler: HandlerTransition, token: Token): ParsedResult {
	const parsed = parseResult(handler, token);
	if (parsed === undefined) {
		throw new TypeError(`${handler.id}: ${tokenKey(token)} is not a result`);
	}
	return parsed;
}
