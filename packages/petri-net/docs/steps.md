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

## 5 Indexed steps

`indexMarking(net, marking)` builds a linear owner from stored token order, with an empty journal.
`stepIndexed(indexed, policy, limit?)` returns `{ indexed, fired, limited }`. `addTokensIndexed(indexed, place, tokens)` returns a new
owner. Both consume the old owner before callbacks run. Discard a consumed owner after any failure.
`enabledElementsIndexed` and `markingOfIndexed` read without consuming. Materializing a marking costs all live tokens.
The pure `fire`, `fireStep`, `enabledBindings`, and `enabledElements` remain unchanged as the oracle.

The optional firing limit applies after allocation resolves token conflicts. If the allocated step exceeds the limit,
the engine fires nothing and returns an unchanged marking and journal with `limited: true`. It never truncates a step.
Without a limit, all allocated elements fire. Tests: `test/indexed-step.test.ts`
"a firing limit refuses the whole allocated step and preserves its journal for a later attempt",
"a firing limit counts allocated elements rather than competing policy candidates".

Each place keeps arrival numbers and FIFO copies per value key. Each transition caches candidates and their demands.
Rejected combinations retain front watchers. A different front representative replaces the cached guard and demand,
including their watchers. Representation-sensitive join keys move values between buckets and create newly matching
combinations. Notification updates every domain before it refreshes candidates. It discards changed candidates, then
creates their replacements through the same arrival path as new values. Count-only changes keep cached results.
Watchers update candidates only for changed keys. New first-arc values create combinations, restricted by declared
join buckets. Dirty transitions sort enabled candidates by the front arrival numbers in variable declaration order.
Allocation reserves counts in an overlay. Cached bindings reuse demand. Invented bindings receive full validation.
All removals precede outputs, so no firing uses a token produced in the same step.

- Front changes preserve the representative object and binding order.
  Test: `test/indexed-step.test.ts` "changed fronts rebuild bindings with the first surviving token object".
- Front changes replace cached expression demand and join membership.
  Tests: `test/indexed-step.test.ts` "front changes replace expression demand and its watchers",
  "front changes move join buckets and create newly matching combinations".
- Count changes update expression demands without repeating guards or expressions.
  Test: `test/indexed-step.test.ts`
  "expression demand watchers enable cached candidates without rerunning guards or expressions".
- A drained index retains no obsolete token copies, candidates, join entries, or watcher keys.
  Retired bindings leave the lookup cache even when a caller retains their occurrences.
  Arrival counters and fixed per-net containers may remain.
  Test: `test/indexed-step.test.ts` "draining and refilling a net retains no obsolete token or candidate entries".
- Duplicate and invented elements obey the same allocation rules.
  Test: `test/indexed-step.test.ts`
  "invented and duplicate policy elements use remaining counts and validate their own transition".
- A policy can reuse a retired binding. Allocation validates it against the current marking without changing its representation.
  Test: `test/indexed-step.test.ts`
  "a policy can reuse a retired binding after equal tokens return with a different representation".
- An indexed step does not key unchanged tokens or repeat cached guards.
  Test: `test/step.test.ts` "an indexed step does not key unchanged tokens or rerun cached guards".
- Consumed owners reject reads and mutations, even after a callback failure.
  Tests: `test/indexed-step.test.ts` "consumed owners reject every read and mutation, including after an empty addition",
  "policy and output failures leave the old owner spent", "candidate failures during an addition leave the old owner spent".

The readable `journal` contains ordered `remove(place, index)`, `append(place, tokens)`, and `drop(place)` operations.
Each removal index refers to the array after preceding operations. A drop deletes an empty place.
A refill appends the place to the marking's key order. Apply the journal in order, then call
`clearJournalIndexed(indexed)` after persistence succeeds. This consumes the owner and returns an owner with an empty
journal. It does not change the marking or the candidates.
Test: `test/indexed-step.test.ts` "journal replay preserves token order and place order through removal, drop and refill".

Policies still receive the full enabled list. Their cost is at least linear in that list.
The stored arrival array uses binary search for a removal index, followed by array compaction.
Thus removal still moves array entries even though it does not key or enumerate unchanged tokens.

## 6 Declared joins

`Transition.joinKeys` optionally assigns a pure, deterministic key function to some declared variables.
A true guard must imply equal join keys for all listed variables. The indexed engine combines values only within
matching buckets. An incorrect declaration silently omits bindings. The net author must prove the implication.
The pure functions ignore this optimization and remain an oracle. A variable shared by several arcs needs no
declaration: its first arc supplies values, and the other arcs supply count requirements.

- Valid declarations preserve the unjoined oracle, including arrival order.
  Test: `test/indexed-step.test.ts` "P4: valid join keys preserve the unjoined oracle across additions and steps".
- Partial joins and many-to-one keys preserve the oracle and check only matching combinations.
  Tests: `test/indexed-step.test.ts` "partial many-to-one joins preserve the oracle when an unjoined variable arrives",
  "a join bucket retains other values when one value leaves".
- Enumeration fixes the arriving value before candidate lookup or guard evaluation. Each combination has one key
  per domain, in declaration order.
  Test: `test/indexed-step.test.ts` "a fixed arrival enumerates only its combinations, before guard evaluation".
- A broken declaration can omit enabled elements.
  Test: `test/indexed-step.test.ts` "P4 detects a broken join declaration by finding a counterexample".
- Join names must name declared variables.
  Test: `test/net-problems.test.ts` "reports a join key for an undeclared variable".
