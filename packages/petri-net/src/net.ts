import type { PlaceId, TransitionId } from "./ids.ts";
import type { Token } from "./token.ts";

/**
 * A colour set is a type of tokens: the tokens a place may hold, or the values a variable may take.
 * `contains` is its membership test. A TypeBox schema becomes a colour set with `Value.Check(schema, token)`.
 * It holds only JSON values: `contains` is false for a non-finite number.
 */
export type ColourSet = { readonly name: string; readonly contains: (token: Token) => boolean };

/** A place holds a multiset of tokens of its colour set. */
export type Place = { readonly id: PlaceId; readonly colourSet: ColourSet };

/** A binding gives each variable of one transition a value. `V` names the variables. */
export type Binding<V extends string = string> = Readonly<Record<V, Token>>;

/**
 * An input arc whose expression is a list of the transition's variables. The arc takes one token for each entry:
 * the value the binding gives that variable. `["x", "x"]` takes two equal tokens. Variables take their values only
 * from the places of these arcs.
 */
export type VariableInputArc<V extends string = string> = {
	readonly place: Place;
	readonly variables: readonly V[];
	/** Not on this arc: an arc with both lists and an expression does not compile. */
	readonly expression?: never;
};

/**
 * An input arc whose expression returns, for a binding, the tokens that the arc takes from its place. It runs only
 * for a binding whose values are right and whose guard is true, so a guard can protect it. It must be pure and
 * deterministic, as an output arc's expression.
 */
export type ExpressionInputArc<V extends string = string> = {
	readonly place: Place;
	readonly expression: (binding: Binding<V>) => readonly Token[];
	/** Not on this arc: an arc with both lists and an expression does not compile. */
	readonly variables?: never;
};

/** An input arc lists variables or computes its tokens from the binding. */
export type InputArc<V extends string = string> = VariableInputArc<V> | ExpressionInputArc<V>;

/** An output arc's expression returns, for a binding, the tokens that the arc puts on its place. */
export type OutputArc<V extends string = string> = {
	readonly place: Place;
	readonly expression: (binding: Binding<V>) => readonly Token[];
	/** Not on this arc: an arc with both lists and an expression does not compile. */
	readonly variables?: never;
};

/** A transition of a coloured net. `V` names its variables; each one occurs on a variable input arc. */
export type Transition<V extends string = string> = {
	readonly id: TransitionId;
	/** Each variable with its colour set. A variable's colour set is the colour set of each place it takes from. */
	readonly variables: Readonly<Record<V, ColourSet>>;
	/**
	 * The condition a binding must meet. A transition with no condition has `() => true`. The binding's values may
	 * have another key order than the tokens on the place, so it compares tokens by value, for example with `tokenKey`.
	 */
	readonly guard: (binding: Binding<V>) => boolean;
	readonly inputs: readonly InputArc<V>[];
	readonly outputs: readonly OutputArc<V>[];
};

/** A coloured net: its places and its transitions. Each arc names a place of the net. */
export type Net = { readonly places: readonly Place[]; readonly transitions: readonly Transition[] };
