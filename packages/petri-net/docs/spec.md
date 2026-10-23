# petri-net specification

The core rule:

> A transition fires only when each input place holds at least the tokens that its input arcs consume.
> Firing returns a new marking and never changes the marking it reads.

## 1 Terms

- A **place** holds tokens. A `PlaceId` names it.
- A **transition** has input arcs and output arcs. A `TransitionId` names it.
- An **arc** connects a transition to one place and has a **weight**: the number of tokens it moves.
  A weight is a positive integer.
- A **marking** is the number of tokens on each place. A place that is not in the marking holds no tokens.
  The marking is a plain JSON object, so a store can keep it as a document without conversion.
- A transition is **enabled** when no input place has a **shortfall**: fewer tokens than the transition consumes there.
  Two arcs from the same place add their weights.
- A **net** is a list of transitions.

## 2 Invariants

Each invariant names the test that proves it. Paths are relative to this package.

- `fire` succeeds exactly when the transition is enabled, and `isEnabled` is true exactly when `shortfalls` is empty.
  Test: `test/fire.test.ts` "is enabled exactly when it has no shortfalls".
- A firing removes the input weights and adds the output weights, and nothing more.
  Test: `test/fire.test.ts` "moves exactly the arc weights".
- No place holds zero or a negative count: a place that reaches zero leaves the marking.
  Tests: `test/fire.test.ts` "never leaves a negative or zero count", `test/marking.test.ts` "removes a place that reaches zero".
- Firing does not change its input marking.
  Test: `test/fire.test.ts` "does not change the marking it reads".
- Two arcs from the same place count as one demand.
  Test: `test/fire.test.ts` "adds the weights of two arcs from the same place".
- Any sequence of firings gives the same markings as an independent model. The generated places include
  `constructor` and `__proto__`, so a marking never reads an inherited property.
  Tests: `test/model.test.ts` "any sequence of firings matches the model", with the places in `test/arbitraries.ts`.

## 3 Failures

- A transition that is not enabled is an expected failure. `fire` returns `Err` with kind `not-enabled` and
  every shortfall. Test: `test/fire.test.ts` "reports each shortfall when the transition is not enabled".
- A count below zero or a count that is not an integer can come only from a bug. `addTokens` throws a `RangeError`.
  Test: `test/marking.test.ts` "refuses a count below zero or a count that is not an integer, which only a bug can cause".
- `netProblems` lists each weight that is not a positive integer and each id that two transitions use.
  A caller that gets a problem has a bug. Tests: `test/net-problems.test.ts`.

## 4 Boundaries

- The package imports no Node builtin and no npm package, and it reads no clock and no randomness.
  It runs in any JavaScript runtime.
- The public names are the exports of `src/index.ts`. Their signatures are in `api/petri-net.api.md`.
