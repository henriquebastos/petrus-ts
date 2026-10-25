# Aborts

The core rule:

> A handler transition that declares the variant `aborted` lets the host abort its operations. `abort(operationId)`
> stops the handler through its signal. Then one commit records the result `{ variant: "aborted", value: null }`,
> steps the net until it is quiet, and ends the task. The variant's arcs give the tokens back. The host decides when
> to abort: the net cannot abort its own work.

## 1 Terms

- The **variant `aborted`** is a variant like any other (see [handlers.md](handlers.md)). Its colour set must hold
  `null`, the value of an aborted result.
- `NetInstance.abort(operationId, context)` finds the operation's Durable task in the task records, which Durable
  keeps after a task ends, and calls `Harness.abortTask`. It returns `marked` when the abort was recorded, and
  `terminal` when the task had already ended. As a rule that task recorded the operation's result, but a faulted
  task leaves its operation in flight (section 3).
- Durable marks the task, aborts the handler's `signal` (`HandlerContext.signal`), and waits until the run ends.
  Then the task's abort handler makes the commit of the core rule. A sleeping task, as one with a delayed result,
  ends its sleep at once, and its delayed result does not count.
- An abort and a result are ordered by Durable: when the result's commit lands first, the abort returns
  `terminal`; when the abort lands first, the result's commit is refused.

## 2 Guarantees

Paths are relative to this package.

- An abort while the handler runs stops it, records `aborted` once, and gives the tokens back. An abort before the
  task runs records `aborted`, and the handler does not run. Tests: `test/aborts.test.ts` "aborting an operation
  whose handler runs stops the handler through its signal, records the result aborted once, and gives the slot
  back", "aborting an operation before its task runs records aborted, and the handler never runs".
- An abort of a sleeping operation records `aborted`, not the delayed result.
  Test: `test/aborts.test.ts` "aborting a sleeping operation records aborted, not its delayed result".
- An abort of an operation that has ended returns `terminal` and changes nothing.
  Test: `test/aborts.test.ts` "aborting an operation that has ended returns terminal and changes nothing".
- `abort` finds the task of each operation, also when the task records take more than one page.
  Test: `test/aborts.test.ts` "finds the task of each of 101 operations, across pages of task records, and refuses
  an operation with none".
- `abort` looks only in the conversation of its net instance, as another conversation can have an operation with
  the same id. Test: `test/aborts.test.ts` "aborts only the operation of its own net instance, when another
  conversation has an operation with the same id".
- The host aborts some operations at times the scheduler chooses, also operations that start later, work ends in
  any order, some of it after a delay, and a process
  dies before or after any commit lands. A new process enqueues again and aborts again. At every commit the
  marking is the replay of the log and the net is quiet. At the end every job ended once, the slots are back,
  nothing is in flight and no task is live. Each operation whose abort returned `marked` ended `aborted`, and only
  an operation that the host tried to abort did. Test: `test/aborts.test.ts` "every job ends once and each marked
  abort ends its operation aborted, under any order of work and aborts and a crash at any commit", with
  `abortFaultProperty` in `test/abort-properties.ts`.

The simulation gate shows that `abortFaultProperty` fails on three planted defects: an abort that records nothing
(`fixtures/simulation/lost-abort-runtime.ts`), an abort of a sleeping task that records its delayed result
(`fixtures/simulation/due-on-abort-runtime.ts`), and an abort of a task other than the one named
(`fixtures/simulation/wrong-task-abort-runtime.ts`).

## 3 Failures

- An operation that has not started is a bug in the host, so `abort` throws.
  Test: `test/aborts.test.ts` "refuses to abort an operation that has not started, which is a bug in the host".
- A transition with no variant `aborted`: `abort` throws, because the operation's tokens would stay taken.
  Test: `test/aborts.test.ts` "refuses to abort an operation whose transition declares no variant aborted, which
  would keep its tokens".
- A variant `aborted` whose colour set does not hold `null` is a net problem: `createRuntime` throws.
  Test: `test/aborts.test.ts` "refuses an aborted variant whose colour set does not hold null, which is a bug in
  the net".
- A throw in the abort's commit, from a bug in the net or the store such as a net that does not become quiet, ends
  the task as faulted, with no retry: a retry would throw again. Durable reports it. The operation stays in flight
  with its tokens taken, and a later `abort` returns `terminal`. Durable also faults a task whose abort handler a
  crash cuts off too often (its restart limit).

## 4 Limits

- Other Durable aborts reach the task too, such as a conversation abort. With no variant `aborted`, the task ends
  with nothing recorded, and its tokens stay taken. Test: `test/aborts.test.ts` "an aborted task of a transition
  with no variant aborted ends with nothing recorded, and its tokens stay taken".
- The net cannot cancel its own work: Durable has no abort inside a commit. A deadline is a variant of the work
  (the handler stops at its limit), or a race of the work and a timer whose loser the host aborts.
- A handler that does not watch its signal makes the abort wait until its work ends.
- `abort` does not start scheduling: it can return `marked` before the result is recorded. The result comes once
  the process schedules tasks (`harness.resume()`).
- `aborted` gives the tokens back once the run has stopped. It does not undo work outside that goes on after a
  process died: see the lease or fence in section 5 of
  [examples/classics/README.md](../../../examples/classics/README.md). Work that the abort cut off may also have
  been done before the abort landed, so a net that compensates must undo it.
- Each abort scans the conversation's task records, so its cost grows with the operations.
