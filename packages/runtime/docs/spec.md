# runtime specification

> Each enqueue or operation result commits atomically: it adds tokens, steps until quiet, writes changes, and creates
> operation tasks. Each request id applies once. Acknowledgment follows the commit.

## 1 Terms

- A **net instance** belongs to one Durable conversation. Its **state** is a marking and a log.
- The **log** records occurrences and ingresses in commit order. Replaying it from no tokens gives the marking.
- An **occurrence** records a binding element and its time. A step's occurrences share a time and preserve firing order.
- A **batch** gives tokens as a marking under a host **request id**. An **ingress** records that batch and its time.
  Retries use the same request id.
- A **commit** updates the conversation's `petrus.net-instance` Durable document, which keeps only its latest value.
  The log is the history. Forks start empty.
  Version 1 stores request ids in 1024 sorted array buckets and includes a cache stamp. There is no migration.
  Tests: `test/net-instance-record.test.ts` "has one version and no migration",
  "initializes with an empty stamp and 1024 independent empty buckets".
- A **step** calls `stepIndexed` with the **selection policy**. A commit leaves the net **quiet**: the policy selects
  nothing. One commit fires at most `stepLimit` (1,000) steps.
- The **clock** supplies commit times. The runtime and Harness must share it.
- `createRuntime({ name, nonce, net, policy, clock, handlers, retryDelayMs })` returns `{ extension, instance }`; the host
  installs `extension` before `Harness.open`. Each runtime of a Harness needs its own `name`: Durable's registry
  replaces an extension of the same name silently. `instance(harness, conversationId)` returns the conversation's
  `NetInstance`.
- The host supplies a fresh **nonce** for each runtime object, including after restarts, for example a random UUID.
  A commit-attempt counter extends it into a stamp. Writers that edit a record outside the runtime must clear its stamp.
- `NetInstance.enqueue(batch, context)` returns `{ ingress, fired }`: the ingress and what the commit's steps
  fired. `state(context)` returns the committed state. `inFlight(context)` lists the operations
  in flight (see [handlers.md](handlers.md)).
- `admit`, `plan`, and `advanceUntilQuiet` consume an indexed marking. A **view** (`src/net-instance-view.ts`)
  gives the index, log length, and log entries on demand. Each runtime caches up to 8 instances, with least-recently-used
  eviction. This bounds instance count, not bytes. A matching stamp reuses an index. A miss copies and validates the
  stored marking once. Test: `test/net-instance-cache.test.ts` "the default cache retains eight instances and putting
  an existing entry refreshes its recency".

## 2 Guarantees

Paths are relative to this package.

- Cached commits and rebuilt commits preserve the same state and JSON key order. A commit replays only its marking
  journal and changes one ingress bucket. Tests: `test/net-instance-cache.test.ts` "cached and rebuilt commits
  preserve the oracle's state and JSON key order"; `test/net-instance-record.test.ts` "one commit changes exactly
  one ingress bucket path".
- Taking a cached index removes it. A throw discards it, and an aborted transaction leaves a mismatched stamp.
  Test: `test/net-instance-cache.test.ts` "a transaction aborted after the journal write cannot reuse the uncommitted index".
- Matching stamps skip marking reads, including after redelivery. Empty stamps and foreign stamps force
  rebuilding, even with equal log lengths. Tests: `test/net-instance-cache.test.ts` "matching stamps avoid marking
  reads for new and repeated batches", "an empty stamp never reuses another instance's cached marking",
  "a foreign writer's stamp rebuilds the index even when the log length is unchanged".
- Each stamp has the runtime nonce and a fixed-width hexadecimal counter. Test: `test/net-instance-cache.test.ts`
  "stamps keep a fixed-width hexadecimal counter across digit boundaries".
- `advanceUntilQuiet` steps until the policy selects nothing and returns the occurrences in firing order, stamped
  with the given time. A net that can still fire after `stepLimit` steps throws. Tests:
  `test/advance.test.ts` "steps until the policy selects nothing and returns every occurrence in firing order",
  "fires up to stepLimit steps, and throws for a net that can still fire after them, which is a bug in the net".
- `admit` adds a new batch's tokens after the tokens on each place and returns its new ingress. For a request id
  that the log holds with the same tokens, it returns the recorded one. The order of places does not count; the
  order of tokens on a place does. Tests: `test/admit.test.ts` "applies a new batch: adds its tokens after
  those already there and returns its ingress", "returns the recorded ingress for a request id the
  log holds, whatever the order of its places", "counts the order of tokens on a place, so the same id with the
  tokens reordered is other tokens".
- `plan` steps a new change until the net is quiet and starts only the operations of its own steps. A commit
  reads only the log entries it needs. Tests: `test/net-instance-commit.test.ts` "steps a new change until the net
  is quiet and starts only the operations that its own steps started", "a new batch reads no log entry, at any log
  length", "a batch sent again reads only its ingress, at any log length", "a result reads only its start and a
  recorded result, at any log length".
- A conversation with no net instance has no tokens and an empty log.
  Test: `test/runtime.test.ts` "a conversation with no instance has no tokens, an empty log and nothing in flight".
- One commit holds a batch's ingress and the occurrences of all its steps, stamped by the clock. Tests:
  `test/runtime.test.ts` "the first enqueue gives the first tokens, and one commit holds its ingress and the steps'
  occurrences, stamped by the clock", "a commit steps until the net is quiet: a policy that fires one element a
  step still fires them all".
- The policy decides which binding element gets a contested token.
  Test: `test/runtime.test.ts` "lets the policy decide which transition takes a contested token".
- A batch sent again returns the recorded ingress and commits nothing, also on a new process after a crash.
  Tests: `test/runtime.test.ts` "a batch sent again returns the recorded ingress, fires nothing and commits
  nothing", "after a crash right after the commit landed, the batch sent again on a new process returns the
  recorded ingress".
- After a crash before or after any commit, redelivery preserves the pure `fireStep` log and leaves the net quiet.
  Test: `test/runtime.test.ts` "adds each batch
  once and leaves every commit quiet when a crash cuts any commit and the host sends every batch again", with
  `crashProperty` in `test/properties.ts`.
- Concurrent enqueues preserve every acknowledged ingress without duplicate request ids or lost updates. Test:
  `test/runtime.test.ts` "loses no acknowledged batch and adds each request id once under any order of concurrent
  enqueues", with `raceProperty` in `test/properties.ts`.

The simulation gate shows that the two properties fail on four planted defects: an enqueue that writes nothing
(`fixtures/simulation/forgetful-runtime.ts`), a batch and its steps in two commits
(`fixtures/simulation/split-commit-runtime.ts`), an enqueue that ignores the stored request ids
(`fixtures/simulation/id-blind-runtime.ts`), and a change made from a read outside the commit
(`fixtures/simulation/stale-read-runtime.ts`).

## 3 Failures

An enqueue has no expected failure. Each case below is a bug or an infrastructure failure: the call rejects.
Only a storage failure can leave a commit behind.

- A storage failure or a crash: the commit may have landed or not, so the host sends the batch again (section 2).
- A net that throws, a policy that names a transition outside the net, or a net that can still fire after
  `stepLimit` steps: nothing is committed. Tests: `test/runtime.test.ts` "rejects an enqueue whose net throws, and
  commits nothing", "rejects an enqueue whose policy names a transition outside the net, and commits nothing",
  "refuses a net that can still fire after stepLimit steps, which is a bug in the net, and commits nothing".
- A batch that does not fit the net (see `markingProblems`), also under a recorded request id: the message names
  every problem. Tests: `test/runtime.test.ts` "rejects a batch that does not fit the net, which is a bug in the
  host, and commits nothing"; `test/admit.test.ts` "refuses a batch that does not fit the net, even under a
  recorded request id".
- A request id that the log holds with other tokens.
  Test: `test/admit.test.ts` "refuses a request id that the log holds with other tokens, which is a bug in the host".
- A conversation that holds an instance of another net, or a stored marking that does not fit the net: `state`
  and `enqueue` reject. Tests: `test/runtime.test.ts` "refuses a conversation that holds an instance of another
  net, which is a bug in the host", "refuses a stored marking that does not fit the net, which is a bug in the
  store".
- `createRuntime` throws when `netProblems` reports a problem, and names every problem.
  Test: `test/runtime.test.ts` "refuses a net with problems, which is a bug in the caller, and names every problem".

## 4 Limits

- The log keeps every request id. A cache miss reads the marking; `state`, `inFlight` and
  `abort` read the whole log.
- The policy has no state, so a policy that needs memory, such as fairness across steps, cannot be written.
