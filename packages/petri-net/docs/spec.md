# petri-net specification

The package is a coloured Petri net in the sense of Jensen and Kristensen, _Coloured Petri Nets_ (2009),
definition 4.2. It keeps their words. The core rule:

> A binding element (a transition and a binding of its variables) fires only when its guard holds and each input
> place holds the tokens that its input arcs take. Firing returns a new marking and never changes the marking it reads.

[steps.md](steps.md) covers steps of many binding elements.

## 1 Terms

- A **token** is a JSON value. Two tokens are equal when their JSON values are equal; the order of object keys
  does not count.
- A **colour set** is a type of tokens. `ColourSet` has a name and a membership test, `contains`.
  A TypeBox schema becomes one through `Value.Check`, as in `test/fire.test.ts`.
- A **place** holds a multiset of tokens of its colour set. A `PlaceId` names it.
- A **transition** has **variables**, each with a colour set, a **guard**, input arcs and output arcs.
  A `TransitionId` names it.
- An **input arc** is a variable input arc or an expression input arc. Two arcs from the same place add up.
- A **variable input arc** (`VariableInputArc`) lists variables. It takes one token for each entry: the value of
  that variable. A variable listed twice takes two equal tokens.
- An **expression input arc** (`ExpressionInputArc`) takes the tokens that its arc expression returns for the
  binding.
- An **arc expression** is a function from the binding to tokens. It must be pure and deterministic.
  An output arc has one; it gives the tokens it returns.
  A guard and an arc expression get the binding's values, whose key order may differ from the tokens on the place,
  so they compare tokens by value, for example with `tokenKey`.
- A **binding** gives each variable of one transition a value of its colour set, and the guard is true for it.
  A transition and a binding form a **binding element**.
- A **marking** is the multiset of tokens on each place, kept in the order the tokens arrived.
  A place with no tokens is not in the marking. The marking is a plain JSON object, so a store keeps it as is.
- A binding element **fires** (Jensen: occurs) by removing the tokens of its input arcs and adding the tokens of its
  output arcs.
- A binding element is **enabled** when no input place has a **shortfall**: a token the binding takes that the
  place does not hold.
- A **net** is a list of places and a list of transitions.

Jensen's tuple (P, T, A, Σ, V, C, G, E, I) maps as: P, T are `Net.places`, `Net.transitions`; A, E are the arcs;
V is `Transition.variables`; C is `Place.colourSet`; G is `Transition.guard`; Σ is the colour sets in use; I is the
tokens of the first batch. Petrus differs in four ways:

- An input arc expression is a list of variables or an opaque function of the binding, with no patterns.
  A guard does the work of a pattern.
- Each variable occurs on a variable input arc. Guards and arc expressions are opaque functions, so a variable
  that only they use could not be enumerated.
- Two arcs from one place to one transition are allowed. They count as one arc whose expression is their sum.
- A colour set holds only JSON values, so no `NaN` or infinity.

## 2 Invariants

Each invariant names the test that proves it. Paths are relative to this package.

- `fire` succeeds exactly for the bindings that `enabledBindings` lists.
  Test: `test/fire.test.ts` "fires exactly the bindings that enabledBindings lists".
- `enabledBindings` lists each binding that an independent model enables, and lists it once. Generated
  transitions include expression input arcs; the model computes their tokens itself.
  Test: `test/model.test.ts` "enabledBindings lists each binding the model enables, once".
- A variable takes values only from its variable input arcs. The order of `enabledBindings` is fixed: variables in
  declaration order, then values in the order of those arcs and, within a place, in arrival order.
  Tests: `test/fire.test.ts` "lists each enabled binding once: variables in declaration order, values in arrival
  order", "takes a variable's values only from the places of its own arcs", "takes a variable's values only
  from variable input arcs, in their order".
- A firing removes the tokens of the input arcs and adds the tokens of the output arcs, and nothing more.
  Test: `test/fire.test.ts` "moves exactly the tokens of the arcs".
- A place that has no tokens left leaves the marking.
  Tests: `test/fire.test.ts` "removes a place that has no tokens left", `test/marking.test.ts`
  "removes a place that has no tokens left".
- Firing and listing bindings do not change the marking they read.
  Test: `test/fire.test.ts` "does not change the marking it reads".
- Tokens are equal by JSON value, and a firing removes the first equal token.
  Tests: `test/fire.test.ts` "treats tokens with equal JSON values as equal, whatever the key order",
  `test/marking.test.ts` "keeps tokens in arrival order and removes the first equal token".
- A variable listed twice takes two equal tokens, and two arcs from the same place add up.
  Test: `test/fire.test.ts` "takes one token for each entry, so a variable listed twice takes two equal tokens".
- A variable on two input arcs takes an equal token from each place.
  Test: `test/fire.test.ts` "a variable on two input arcs needs an equal token on both places".
- A binding element with an expression input arc is enabled only when the place holds the tokens that the
  expression returns. They add up with the tokens of the other arcs from the same place.
  Tests: `test/fire.test.ts` "takes the tokens that an expression input arc computes, and is enabled only when
  they are there", "adds the tokens of an expression input arc to the tokens of a variable arc from the same place".
- An expression input arc runs only for a binding whose values are right and whose guard is true, so a guard can
  protect it. Test: `test/fire.test.ts` "runs an expression input arc only for right values and a true guard".
- Any sequence of firings gives the same tokens, in the same order, as an independent model. The generated places
  include `constructor` and `__proto__`, so a marking never reads an inherited property.
  Tests: `test/model.test.ts` "any sequence of firings matches the model", with the places in `test/arbitraries.ts`.

## 3 Failures

- Values that are not a binding are an expected failure. `fire` returns `Err` with kind `not-a-binding` and a
  problem for each variable with no value, each name that is not a variable, and each value outside its colour set.
  The guard runs only when the values are right; a false guard is a problem too.
  Tests: `test/fire.test.ts` "reports each wrong value as not-a-binding and does not run the guard",
  "reports a false guard as not-a-binding".
- A binding element that is not enabled is an expected failure. `fire` returns `Err` with kind `not-enabled` and
  the tokens that each input place lacks.
  Test: `test/fire.test.ts` "reports the tokens that each input place lacks as not-enabled".
- An output token outside its place's colour set is a bug in the net. `fire` throws a `TypeError`.
  Test: `test/fire.test.ts` "throws a TypeError for an output token outside its place's colour set, a bug in the net".
- An input token from an arc expression outside its place's colour set is a bug in the net too. `fire` and
  `enabledBindings` throw a `TypeError`. Test: `test/fire.test.ts`
  "throws a TypeError for an input token outside its place's colour set, a bug in the net".
- Removing a token that is not there can come only from a bug. `removeTokens` throws a `RangeError`.
  Test: `test/marking.test.ts` "refuses to remove a token that is not there, which only a bug can cause".
- `netProblems` lists each id used twice, each arc to a place outside the net, each variable that is undeclared
  or on no variable input arc, and each variable whose colour set is not the colour set of its place.
  `markingProblems` lists each place outside the net, each place listed with no tokens, and each token outside its
  colour set. A caller that gets a problem has a bug.
  Tests: `test/net-problems.test.ts`, with
  "checks variables on variable input arcs only, and checks the place of an expression input arc".

## 4 Boundaries

- It imports no Node builtin or npm package and reads no clock or randomness, so it runs in any JavaScript runtime.
- `enabledBindings` tries each combination of the distinct tokens on the variable input arcs' places, so its cost
  is the product of those counts. An expression input arc adds no factor: it runs at most once per combination.
  So compute tokens from one variable on an expression input arc, not with more variables and a guard.
  Test: `examples/classics/test/dining-philosophers.test.ts` "computes the forks once for each distinct hungry
  philosopher in one enabledBindings call".
- The public names are the exports of `src/index.ts`. Their signatures are in `api/petri-net.api.md`.
