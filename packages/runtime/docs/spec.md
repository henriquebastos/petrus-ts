# runtime specification

The core rule:

> A step loads the net instance, selects a step with the policy, fires it, and commits the new marking with its
> occurrences in one atomic commit. The steps of one runtime run one at a time. A step is acknowledged only after
> its commit lands.

## 1 Terms

- A **net instance** is one run of a net. Its **state** is a marking and an occurrence log.
- An **occurrence** records one committed binding element (the transition and its binding) and the time from the
  clock. The occurrences of one step share the time and are in firing order, so replaying them one by one with
  `fire` gives the step's tokens (see the petri-net spec).
- A **store** keeps the state of one net instance. `load` returns the last committed state; the first state it
  holds is the initial marking. `commit` is atomic: after a crash the store holds the old state or the new state,
  never a part of each.
- A **step** takes no input. It calls `fireStep` from the petri-net package with the runtime's **selection policy**:
  the policy orders and filters the enabled binding elements, and allocation fires each one whose tokens are still
  free (Jensen's step). See the petri-net spec.
- The **clock** is the only source of time. The runtime takes it as an option.
- **`advance`** (in `src/advance.ts`) is the pure part of a step: it calls `fireStep`, stamps the occurrences with a
  given time and appends them to the log. The runtime adds only the effects: load, commit, and one step at a time.

## 2 Guarantees

Each guarantee names the test that proves it. Paths are relative to this package.

- `advance` appends the step's occurrences, stamped with the given time, and returns the same state when nothing
  fires. Tests: `test/advance.test.ts` "appends the step's occurrences to the log, each stamped with the given time",
  "returns the same state when nothing fires, so the runtime commits nothing".
- A step commits the marking and its occurrences together, and stamps the occurrences with the clock.
  Test: `test/runtime.test.ts` "commits the new marking and the step's occurrences together, stamped by the clock".
- The policy decides which binding element gets a contested token.
  Test: `test/runtime.test.ts` "lets the policy decide which transition takes a contested token".
- A step that fires nothing commits nothing.
  Test: `test/runtime.test.ts` "fires nothing and commits nothing when nothing is enabled".
- After a crash at any commit and a reopen that runs the remaining steps, the stored marking is the replay of the
  stored log, and the log is the log of the pure `fireStep` run step by step. The property draws the policy.
  Test: `test/runtime.test.ts` "stays consistent after a crash at any commit and a reopen",
  with `crashCutProperty` in `test/properties.ts`.
- Under any order in which the store answers, each acknowledged occurrence is in the stored log. Two steps that
  fire from the same marking fail this check.
  Test: `test/runtime.test.ts` "loses no acknowledged step under any interleaving", with `raceProperty` in `test/properties.ts`.
- A failed commit does not block the next step.
  Test: `test/runtime.test.ts` "a failed commit does not block the next step".

A new store, or a new kind of step, must keep `crashCutProperty` and `raceProperty` green.

## 3 Failures

A step has no expected failure. Everything below is a bug or an infrastructure failure, so the step rejects and
commits nothing.

- A store failure: the step rejects with the store's error.
  Test: `test/runtime.test.ts` "a failed commit does not block the next step".
- A bug in the net that `fireStep` throws, such as an output token outside its colour set.
  Test: `test/runtime.test.ts` "rejects a step whose net throws, and commits nothing".
- A policy that names a transition outside the net.
  Test: `test/runtime.test.ts` "rejects a step whose policy names a transition outside the net, and commits nothing".
- A stored marking with a problem from `markingProblems`: the step names every problem.
  Test: `test/runtime.test.ts` "rejects a step when the stored marking does not fit the net, which is a bug in the store".
- `createRuntime` throws when `netProblems` reports a problem, and the message names every problem.
  Test: `test/runtime.test.ts` "refuses a net with problems, which is a bug in the caller, and names every problem".

## 4 Limits

- Tokens enter only through the stored initial state. There is no way yet to add tokens from outside.
- The policy has no state of its own, so a policy that needs memory, such as fairness across steps, cannot be
  written yet.
- The tests model a crash before a commit lands. They do not model a commit that lands and then loses its reply,
  after which the caller does not know whether the step ran.
- The only store is the test store in `test/controlled-store.ts`.
