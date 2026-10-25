import fc from "fast-check";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type {
	Binding,
	ColourSet,
	ExpressionInputArc,
	Marking,
	Net,
	OutputArc,
	Place,
	PlaceId,
	SelectionPolicy,
	Token,
	Transition,
	VariableInputArc,
} from "../src/index.ts";
import { definitionOrder, placeId, tokensAt, transitionId } from "../src/index.ts";

const bit = Type.Integer({ minimum: 0, maximum: 1 });

/**
 * Small numbers, records, a nested record and pairs, so equal tokens often meet, and key order (at every depth)
 * and array order get tested.
 */
const valueSchema = Type.Union([
	Type.Integer({ minimum: 0, maximum: 2 }),
	Type.Object(
		{ n: Type.Object({ b: bit, c: bit }, { additionalProperties: false }) },
		{ additionalProperties: false },
	),
	Type.Array(bit, { minItems: 2, maxItems: 2 }),
	Type.Object(
		{ a: Type.Integer({ minimum: 0, maximum: 1 }), b: Type.Integer({ minimum: 0, maximum: 1 }) },
		{
			additionalProperties: false,
		},
	),
]);

/** A TypeBox schema as a colour set: the one colour set of every generated place and variable. */
const valueColourSet: ColourSet = { name: "Value", contains: (token) => Value.Check(valueSchema, token) };

/**
 * A small pool of places, so generated transitions often share places and interact. Two names are also
 * properties of every plain object, so a marking that reads inherited properties fails the properties.
 */
export const places: readonly Place[] = ["a", "b", "constructor", "__proto__"].map((name) => ({
	id: placeId(name),
	colourSet: valueColourSet,
}));

/** Tokens in the colour set. Each record appears with both key orders; the pair appears in both orders. */
const tokenArbitrary: fc.Arbitrary<Token> = fc.constantFrom<Token>(
	0,
	1,
	2,
	{ a: 0, b: 1 },
	{ b: 1, a: 0 },
	{ n: { b: 0, c: 1 } },
	{ n: { c: 1, b: 0 } },
	{ n: { b: 1, c: 1 } },
	[0, 1],
	[1, 0],
);

/** Binding values: the tokens above, and one value outside the colour set. */
const valueArbitrary: fc.Arbitrary<Token> = fc.oneof(
	{ arbitrary: tokenArbitrary, weight: 9 },
	{ arbitrary: fc.constant<Token>(3), weight: 1 },
);

/** `constructor` is a property of every plain object, so a binding that reads inherited properties fails. */
const variableNames = ["x", "constructor"] as const;

/** A guard compares tokens by value, as the net does: object key order does not count. */
const guards: readonly ((binding: Binding) => boolean)[] = [
	() => true,
	(binding) => binding.x !== 1,
	(binding) => {
		const values = new Map(Object.entries(binding));
		return canonical(values.get("x")) === canonical(values.get("constructor"));
	},
];

const expressions: readonly OutputArc["expression"][] = [
	(binding) => Object.values(binding),
	() => [0],
	() => [{ b: 0, a: 1 }],
	(binding) => Object.values(binding).map((token) => (typeof token === "number" ? (token + 1) % 3 : token)),
];

const placeArbitrary = fc.constantFrom(...places);

const variableArcArbitrary: fc.Arbitrary<VariableInputArc> = fc.record({
	place: placeArbitrary,
	variables: fc.array(fc.constantFrom(...variableNames), { minLength: 1, maxLength: 2 }),
});

/** The output expressions serve as input expressions too: each gives tokens of the colour set for a binding. */
const expressionArcArbitrary: fc.Arbitrary<ExpressionInputArc> = fc.record({
	place: placeArbitrary,
	expression: fc.constantFrom(...expressions),
});

/**
 * A transition whose variables are exactly the variables on its variable input arcs, all of colour set Value.
 * Some input arcs compute their tokens from the binding instead.
 */
export const transitionArbitrary: fc.Arbitrary<Transition> = fc
	.record({
		id: fc.constantFrom("t1", "t2", "t3").map(transitionId),
		inputs: fc.array(fc.oneof({ arbitrary: variableArcArbitrary, weight: 3 }, expressionArcArbitrary), {
			maxLength: 3,
		}),
		guard: fc.constantFrom(...guards),
		outputs: fc.array(fc.record({ place: placeArbitrary, expression: fc.constantFrom(...expressions) }), {
			maxLength: 3,
		}),
	})
	.map((transition) => ({
		...transition,
		variables: Object.fromEntries(
			variableNames
				.filter((name) => transition.inputs.some((arc) => arc.variables?.includes(name) === true))
				.map((name) => [name, valueColourSet]),
		),
	}));

/**
 * How a test picks a binding. For each variable an index picks a token from the place of its first variable input
 * arc; an index past the end takes the fallback value instead. The shape sometimes drops a variable or adds one.
 */
export type Choice = {
	readonly indices: readonly number[];
	readonly fallbacks: readonly Token[];
	readonly shape: "exact" | "missing" | "extra";
};

export const choiceArbitrary: fc.Arbitrary<Choice> = fc.record({
	indices: fc.array(fc.nat({ max: 3 }), { minLength: variableNames.length, maxLength: variableNames.length }),
	fallbacks: fc.array(valueArbitrary, { minLength: variableNames.length, maxLength: variableNames.length }),
	shape: fc.constantFrom<Choice["shape"]>(...Array<"exact">(8).fill("exact"), "missing", "extra"),
});

/** The binding that `choice` picks when the places hold `tokensOf`. Most picks are tokens that are there. */
export function chooseBinding(
	transition: Transition,
	tokensOf: (place: PlaceId) => readonly Token[],
	choice: Choice,
): Binding {
	const values = Object.keys(transition.variables).map((name, index): [string, Token] => {
		const arc = transition.inputs.find((input) => input.variables?.includes(name) === true);
		const candidates = arc === undefined ? [] : tokensOf(arc.place.id);
		return [name, candidates[choice.indices[index] ?? 0] ?? choice.fallbacks[index] ?? null];
	});
	const binding = Object.fromEntries(choice.shape === "missing" ? values.slice(1) : values);
	return choice.shape === "extra" ? { ...binding, z: 0 } : binding;
}

export const markingArbitrary: fc.Arbitrary<Marking> = fc
	.tuple(...places.map(() => fc.array(tokenArbitrary, { maxLength: 4 })))
	.map((lists) =>
		Object.fromEntries(
			places.flatMap((place, index) => {
				const tokens = lists[index] ?? [];
				return tokens.length > 0 ? [[place.id, tokens]] : [];
			}),
		),
	);

/** One to three transitions over the shared places, with ids t1, t2, t3 in definition order. */
export const netArbitrary: fc.Arbitrary<Net> = fc
	.array(transitionArbitrary, { minLength: 1, maxLength: 3 })
	.map((transitions) => ({
		places,
		transitions: transitions.map((transition, index) => ({
			...transition,
			id: transitionId(`t${String(index + 1)}`),
		})),
	}));

/** Policies that keep, reverse, thin out, repeat, or drop the candidates. */
export const policyArbitrary: fc.Arbitrary<SelectionPolicy> = fc.constantFrom<SelectionPolicy>(
	definitionOrder,
	(enabled) => [...enabled].reverse(),
	(enabled) => enabled.filter((_element, index) => index % 2 === 0),
	(enabled) => [...enabled, ...enabled],
	(enabled) => enabled.filter((element) => element.transition !== transitionId("t1")),
);

/** A marking, a transition, and a binding picked mostly from the marking's tokens. */
export const firingArbitrary: fc.Arbitrary<{ marking: Marking; transition: Transition; binding: Binding }> = fc
	.tuple(markingArbitrary, transitionArbitrary, choiceArbitrary)
	.map(([marking, transition, choice]) => ({
		marking,
		transition,
		binding: chooseBinding(transition, (place) => tokensAt(marking, place), choice),
	}));

/** The model's own equality: a canonical text built apart from the package's `tokenKey`. */
export function canonical(value: Token | undefined): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
		return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
	}
	return value === undefined ? "undefined" : JSON.stringify(value);
}

export function countTokens(marking: Marking): number {
	return Object.values<readonly Token[]>(marking).reduce((sum, tokens) => sum + tokens.length, 0);
}
