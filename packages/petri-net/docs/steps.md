# petri-net steps

A step fires many binding elements of one net together. This file uses the terms of [spec.md](spec.md).

## 1 Terms

- A **step** is a list of binding elements that fire together; it may be empty. Jensen's step is a multiset; the
  list keeps the firing order. Input tokens come from the marking before the step, so no element uses a token that
  the same step produces. A policy may list an element twice to fire it twice (auto-concurrency).
- A **selection policy**, pure and deterministic, orders and filters the enabled binding elements.
  `enabledElements` lists transitions in definition order, then bindings. The default, `definitionOrder`, keeps
  that order; a policy that sorts stably keeps it as its tie-break.
- **Allocation**, fixed in `fireStep`, walks the policy's list and takes each binding element whose input tokens
  the earlier ones left free, so no two elements share a token.

`fireStep(net, marking, policy)` selects and fires a whole step.

## 2 Invariants

Each invariant names the test that proves it. Paths are relative to this package.

- `fireStep` fires the elements and gives the marking that an independent model of allocation gives, for generated
  nets, markings and policies.
  Test: `test/step.test.ts` "fires the elements and gives the marking that the model's allocation gives".
- One resource token admits one binding element per step, and the policy's order decides who gets it.
  Tests: `test/step.test.ts` "fires each element whose tokens are still free, so one resource token admits one
  answer per step", "the policy's order decides which element gets a shared token".
- A token that a step produces is not used in the same step.
  Test: `test/step.test.ts` "a token that the step produces is not used in the same step".
- Firing a step's elements one by one with `fire` gives the step's tokens on each place, so a log of occurrences
  replays. Test: `test/step.test.ts` "replaying the fired elements one by one gives the step's tokens".

## 3 Failures

- A policy that names a transition outside the net is a bug. `fireStep` throws an `Error`.
  Test: `test/step.test.ts` "a policy that names a transition outside the net is a bug, so it throws".

## 4 Boundaries

- A policy has no state of its own yet, so it cannot remember earlier steps, for example for fairness.
