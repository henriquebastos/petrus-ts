# runtime specification

The core rule:

> A step loads the net instance, selects a step with the policy, fires it, and commits the new marking with its
> occurrences in one atomic commit. An enqueue adds a batch of tokens from outside and commits it with its ingress
> and request id in one atomic commit; a request id is applied once. Steps and enqueues of one runtime run one at a
> time, and each is acknowledged only after its commit lands.

## 1 Terms

- A **net instance** is one run of a net. Its **state** is a marking and a log.
- The **log** records, in commit order, each change to the marking: an occurrence or an ingress. Replaying it from
  the first marking gives the current marking.
- An **occurrence** records one committed binding element (the transition and its binding) and the time from the
  clock. The occurrences of one step share the time and are in firing order, so replaying them one by one with
  `fire` gives the step's tokens (see the petri-net spec).
- A **batch** is a set of tokens, given as a marking, that a host adds from outside under its own **request id**.
  An **ingress** records one applied batch, its request id, and the time. The host chooses the id so that a retry
  of the same input, or a second delivery of it, has the same id.
- A **store** keeps the state of one net instance. `load` returns the last committed state; the first state it
  holds is the initial marking. `commit` is atomic: after a crash the store holds the old state or the new state,
  never a part of each.
- A **step** takes no input. It calls `fireStep` from the petri-net package with the runtime's **selection policy**:
  the policy orders and filters the enabled binding elements, and allocation fires each one whose tokens are still
  free (Jensen's step). See the petri-net spec.
- The **clock** is the only source of time. The runtime takes it as an option.
- **`advance`** (in `src/advance.ts`) and **`admit`** (in `src/admit.ts`) are the pure parts of a step and of an
  enqueue. They take the state and a time. `advance` returns the next state; `admit` returns the next state, or the
  recorded ingress when the log holds the request id. The runtime adds only the effects: load, commit, and one call
  at a time.

## 2 Guarantees

Each guarantee names the test that proves it. Paths are relative to this package.

- `advance` appends the step's occurrences, stamped with the given time, and returns the same state when nothing
  fires. Tests: `test/advance.test.ts` "appends the step's occurrences to the log, each stamped with the given time",
  "returns the same state when nothing fires, so the runtime commits nothing".
- `admit` adds a new batch's tokens after the tokens already on each place and appends its ingress. For a request
  id that the log holds with the same tokens, it returns the recorded ingress and no new state. The order of places
  does not count; the order of tokens on a place does. Tests: `test/admit.test.ts` "applies a new batch: adds its
  tokens after the tokens already there and appends its ingress", "returns the recorded ingress for a request id the
  log holds, whatever the order of its places", "counts the order of tokens on a place, so the same id with the
  tokens reordered is other tokens".
- A step commits the marking and its occurrences together, and stamps the occurrences with the clock.
  Test: `test/runtime.test.ts` "commits the new marking and the step's occurrences together, stamped by the clock".
- An enqueue commits the batch's tokens and its ingress together, and stamps the ingress with the clock.
  Test: `test/runtime.test.ts` "enqueues a batch: commits its tokens and its ingress together, stamped by the clock".
- The policy decides which binding element gets a contested token.
  Test: `test/runtime.test.ts` "lets the policy decide which transition takes a contested token".
- A step that fires nothing commits nothing.
  Test: `test/runtime.test.ts` "fires nothing and commits nothing when nothing is enabled".
- After a crash at any commit and a reopen that runs the remaining steps, the stored marking is the replay of the
  stored log, and the log is the log of the pure `fireStep` run step by step. The property draws the policy.
  Test: `test/runtime.test.ts` "stays consistent after a crash at any commit and a reopen",
  with `crashCutProperty` in `test/properties.ts`.
- When one commit fails, whether it landed (a lost reply) or not, a host that retries the batch with the same
  request id adds it once and gets the recorded ingress back. This holds when the retry goes to a new runtime over
  the same store, because the runtime looks request ids up in the stored log, not in memory. A step needs no retry:
  it has no input, so the next step goes on from the committed state, and the log holds what any step fired.
  Tests: `test/runtime.test.ts` "a retry after a lost reply returns the recorded ingress and adds nothing";
  "adds each batch once when a commit fails or its reply is lost and the host retries with the same request id",
  with `retryProperty` in `test/properties.ts`.
- Under any order in which the store answers, with concurrent steps and enqueues and with the same batch delivered
  twice, the stored marking is the replay of the stored log, the log's occurrences are the acknowledged ones, each
  acknowledged ingress is in the log, and each request id is there once.
  Test: `test/runtime.test.ts` "loses no acknowledged step or batch under any interleaving", with `raceProperty` in `test/properties.ts`.
- A failed commit does not block the next step.
  Test: `test/runtime.test.ts` "a failed commit does not block the next step".

A change to the runtime, or a new kind of call, must keep `crashCutProperty`, `retryProperty` and `raceProperty`
green.

## 3 Failures

A step and an enqueue have no expected failure. Everything below is a bug or an infrastructure failure, so the
call rejects. Only a store failure can leave a commit behind.

- A store failure: the call rejects with the store's error. The commit may have landed, as after a lost reply, or
  not. The host retries a batch with the same request id and goes on after a step (see section 2), and the next
  call runs. Tests: `test/runtime.test.ts` "a failed commit does not block the next step", "a retry after a lost
  reply returns the recorded ingress and adds nothing".
- A bug in the net that `fireStep` throws, such as an output token outside its colour set.
  Test: `test/runtime.test.ts` "rejects a step whose net throws, and commits nothing".
- A policy that names a transition outside the net.
  Test: `test/runtime.test.ts` "rejects a step whose policy names a transition outside the net, and commits nothing".
- A batch that does not fit the net (see `markingProblems`): the message names every problem. This holds also for a
  retry whose request id the log holds.
  Tests: `test/runtime.test.ts` "rejects a batch that does not fit the net, which is a bug in the host, and commits
  nothing"; `test/admit.test.ts` "refuses a batch that does not fit the net, which is a bug in the host, and names
  every problem", "refuses a batch that does not fit the net, even under a recorded request id".
- A request id that the log holds with other tokens: the host gave one id to two inputs.
  Test: `test/admit.test.ts` "refuses a request id that the log holds with other tokens, which is a bug in the host".
- A stored marking with a problem from `markingProblems`: the call names every problem.
  Test: `test/runtime.test.ts` "rejects a step and an enqueue when the stored marking does not fit the net, which is a bug in the store".
- `createRuntime` throws when `netProblems` reports a problem, and the message names every problem.
  Test: `test/runtime.test.ts` "refuses a net with problems, which is a bug in the caller, and names every problem".

## 4 Limits

- An enqueue does not step. The host calls `step` until it fires nothing.
- The store contract assumes that `commit` settles only when the write has landed or never will, and that one
  runtime at a time uses a store. A store with client timeouts, or two runtimes over one store, needs a
  conditional commit, which does not exist yet.
- The log keeps every request id, and an enqueue searches the whole log, so its cost grows with the log.
- The policy has no state of its own, so a policy that needs memory, such as fairness across steps, cannot be
  written yet.
- The only store is the test store in `test/controlled-store.ts`.
