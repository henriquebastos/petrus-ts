# Delayed results

The core rule:

> A handler can return a delayed result `{ delayMs, result }`. The result counts `delayMs` after the occurrence
> that started the operation, as the delay `@+delayMs` of a timed net, and not before. Until then the operation
> stays in flight.
> The wait is a Durable sleep, so it keeps its end after a crash.

## 1 Terms

- A **delayed result** (`DelayedResult` in `src/handlers.ts`) is a `delayMs` and a result. `delayMs` is a finite
  number of milliseconds, at least 0.
- The **start time** of an operation is the time of the commit that fired its start transition. All occurrences
  of one commit share that time. The commit gives it to the operation's task.
- When the handler returns a delayed result, the `run` phase checks the result against the handler transition.
  Then it commits a sleep until the start time plus `delayMs`, with the result in the task's checkpoint. The
  handler does not run again.
- At the end of the sleep the task's `due` phase makes the commit of a result: it records the result, steps the
  net until it is quiet, and ends the task as `completed`.
- The result's time is the clock when that commit lands: the **due time** (start time plus delay), or later when
  the commit runs again after a throw or the process wakes late. A wait that the clock has already passed, as
  after an outage, ends at once.

## 2 Guarantees

Paths are relative to this package.

- A delayed result counts at the start time plus its delay, not before. A delay of 0 counts at the start time.
  Tests: `test/delays.test.ts` "a result delayed 10 ms counts at the time of its start plus 10, and not before",
  "a result delayed 0 ms counts at the time of its start".
- A process dies before or after any storage commit lands. After an outage a new process enqueues the first
  batch again and runs the tasks. At every commit the marking is the replay of the log and the net is quiet. Each
  result counts once, at its due time, also when the crash cut its wait or the commit of its sleep; a result that
  the outage made due counts when the new process opens. Test:
  `test/delays.test.ts` "each delayed result counts once and on time when a crash cuts any commit", with
  `delayFaultProperty` in `test/delay-properties.ts`.

The simulation gate shows that `delayFaultProperty` fails on three planted defects: a delay that the runtime
ignores (`fixtures/simulation/early-due-runtime.ts`), a `due` phase that ends the task without the result
(`fixtures/simulation/lost-due-runtime.ts`), and a delay that counts from the handler's run
(`fixtures/simulation/from-run-runtime.ts`).

## 3 Failures

Each failure is reported to the host. The phase runs again after `retryDelayMs`, except after a broken net instance.

- A delay that is not a finite number of at least 0 is a bug in the handler. The handler runs again, and the delay
  of the next run still counts from the start time.
  Test: `test/delays.test.ts` "a delay of %d ms is a bug in the handler: it is reported, and the handler runs again
  after retryDelayMs".
- A delayed result that does not fit the handler transition is reported before the task sleeps, and the handler
  runs again. Test: `test/delays.test.ts` "a delayed result that does not fit the transition is reported before the
  task sleeps, and the handler runs again".
- A throw in the commit of a due result: the `due` phase runs again, and the handler does not.
  Test: `test/delays.test.ts` "a throw in the commit of a due result is reported, and the result commits after
  retryDelayMs, with no new run of the handler".
- A broken net instance in the commit of a due result ends the task as faulted, with no new run of the handler:
  see [broken-instances.md](broken-instances.md).

## 4 Limits

- A delay counts from the start time. A handler cannot ask for an absolute time, such as a time of day, because it
  gets no clock.
- An aborted sleeping task ends as `aborted`, and its delayed result never counts. Tests: `test/delays.test.ts`
  "aborting a sleeping task ends it as aborted, and its result never counts"; with a variant `aborted`,
  `test/aborts.test.ts` "aborting a sleeping operation records aborted, not its delayed result".
- A sleep ends only in a running process with scheduling on (`harness.resume()`). Without the Harness option
  `onWake`, Durable arms a timer for the earliest sleep. With `onWake`, the host arms its own wakeup at the time
  that `harness.wake()` gives, and calls `resume()` then.
