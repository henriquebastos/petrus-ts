# runtime specification

The core rule:

> A step loads the net instance, fires one transition, and commits the new marking with its occurrence in one atomic commit.
> The steps of one runtime run one at a time. A step is acknowledged only after its commit lands.

## 1 Terms

- A **net instance** is one run of a net. Its **state** is a marking and an occurrence log.
- An **occurrence** records one committed firing: the transition and the time from the clock.
- A **store** keeps the state of one net instance. `load` returns the last committed state.
  `commit` is atomic: after a crash the store holds the old state or the new state, never a part of each.
- A **step** fires one transition by id.
- The **clock** is the only source of time. The runtime takes it as an option.

## 2 Guarantees

Each guarantee names the test that proves it. Paths are relative to this package.

- A step commits the marking and the occurrence together, and stamps the occurrence with the clock.
  Test: `test/runtime.test.ts` "commits the new marking and the occurrence together, stamped by the clock".
- After a crash at any commit and a reopen that runs the remaining steps, the stored marking is the replay of the
  stored log, and the log is the log of an independent model. Test: `test/runtime.test.ts` "stays consistent after a crash at any commit and a reopen",
  with `crashCutProperty` in `test/properties.ts`.
- Under any order in which the store answers, each acknowledged step is in the stored log. In the test net two
  transitions compete for one token, so two steps that fire from the same marking fail this check.
  Test: `test/runtime.test.ts` "loses no acknowledged step under any interleaving", with `raceProperty` in `test/properties.ts`.
- A failed commit does not block the next step.
  Test: `test/runtime.test.ts` "a failed commit does not block the next step".

A new store, or a new kind of step, must keep `crashCutProperty` and `raceProperty` green.

## 3 Failures

- A transition that is not enabled returns `Err` with kind `not-enabled`, and the step commits nothing.
  Test: `test/runtime.test.ts` "returns not-enabled and commits nothing when the token is gone".
- An id that is not in the net returns `Err` with kind `unknown-transition`.
  Test: `test/runtime.test.ts` "returns unknown-transition for an id that is not in the net".
- A store failure is not an expected failure. The step rejects with the store's error.
- `createRuntime` throws when `netProblems` reports a problem, and the message names every problem.
  Test: `test/runtime.test.ts` "refuses a net with problems, which is a bug in the caller, and names every problem".

## 4 Limits

- The tests model a crash before a commit lands. They do not model a commit that lands and then loses its reply,
  after which the caller does not know whether the step ran.
- The only store is the test store in `test/controlled-store.ts`.
