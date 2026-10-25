# runtime specification

The core rule:

> A change to a net instance is an enqueue or an operation's result. Each change is one atomic commit: it reads the
> net instance, applies the change, steps the net until the policy selects nothing, writes the result, and creates a
> task for each operation that its steps started. A request id is applied once. A call is acknowledged only after
> its commit lands.

## 1 Terms

- A **net instance** is one run of a net. Its **state** is a marking and a log. One Durable conversation holds one
  net instance.
- The **log** records, in commit order, each change to the marking: an occurrence or an ingress. Replaying it from
  no tokens gives the marking.
- An **occurrence** records one committed binding element and its time. The occurrences of one step share the
  time and are in firing order, so replaying them one by one with `fire` gives the step's tokens.
- A **batch** is a set of tokens, given as a marking, that a host adds from outside under its own **request id**.
  An **ingress** records one applied batch, its request id, and the time. A retry of the same input, or a second
  delivery of it, has the same id.
- A **commit** is one Durable commit. The runtime stores a net instance as one Durable document of kind
  `petrus.net-instance` in its conversation, with the log index of each ingress by request id. The document keeps
  only its latest value: the log is the history. A fork of the conversation starts with no net instance.
  Migration adds the index to a version 1 document. Test: `test/net-instance-record.test.ts` "migrates a
  version 1 record by indexing its ingresses".
- A **step** calls `fireStep` from the petri-net package with the runtime's **selection policy** (Jensen's step;
  see the petri-net spec). A commit steps until the policy selects nothing, so the net is **quiet** after each
  commit. One commit fires at most `stepLimit` (1,000) steps.
- The **clock** is the only source of time. An enqueue reads it inside its commit. A handler task takes its time
  from the Harness, so the Harness gets the same clock as `now`.
- `createRuntime({ name, net, policy, clock, handlers, retryDelayMs })` returns `{ extension, instance }`; the host
  installs `extension` before `Harness.open`. Each runtime of a Harness needs its own `name`: Durable's registry
  replaces an extension of the same name silently. `instance(harness, conversationId)` returns the conversation's
  `NetInstance`.
- `NetInstance.enqueue(batch, context)` returns `{ ingress, fired }`: the ingress and what the commit's steps
  fired. `state(context)` returns the committed state. `inFlight(context)` lists the operations
  in flight (see [handlers.md](handlers.md)).
- `admit` in `src/admit.ts` and `plan` in `src/net-instance-commit.ts` are pure: they take a time and a **view**
  (`src/net-instance-view.ts`) that gives the marking, the log length, and log entries on demand. So is
  `advanceUntilQuiet` in `src/advance.ts`, on a marking. The runtime adds the effects inside one commit: the read,
  the write, and the new tasks.

## 2 Guarantees

Paths are relative to this package.

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
- A process dies before or after any of its commits lands, and a new process sends every batch again. At every
  commit the marking is the replay of the log and the net is quiet. Each batch is in the log once, and the log is
  that of the pure `fireStep` run. The property draws the policy. Test: `test/runtime.test.ts` "adds each batch
  once and leaves every commit quiet when a crash cuts any commit and the host sends every batch again", with
  `crashProperty` in `test/properties.ts`.
- Up to four enqueues of two batches, duplicates included, run at once, and their commits land in any order. The
  same holds at every commit. Each acknowledged ingress is in the log, and each request id is there once. A commit
  reads the net instance inside itself, so it never writes over another commit's change. Test:
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

- The log keeps every request id. A commit reads the marking and the log entries it needs; `state`, `inFlight` and
  `abort` read the whole log.
- The policy has no state, so a policy that needs memory, such as fairness across steps, cannot be written.
