# 1 Native sleeps and explicit retries

Execution tasks use Durable's `sleepUntil` and native checkpoints. Petrus no longer interprets delayed-result wrappers
or retries every thrown error. Each native task chooses its deadline, saved result, retry policy, and abort behavior.

## 1a Deadlines

`ExecutionInput.startedAt` is the allocation commit's time. A task can implement a timed-net delay with
`input.startedAt + delayMs`. It can instead use an absolute deadline or its native runtime clock.
The host and runtime must share the same clock.

After committing a sleep, the phase returns. Durable retains the deadline and checkpoint across reopen.
The next phase resumes when scheduling runs at or after that deadline. A task can save a selected result in its
checkpoint and complete later without repeating the external work.

Test: `test/execution.test.ts`
"registers unrelated native tasks and preserves their input, ownership, checkpoints and results".
The production coordination crash test `test/coordination.test.ts`
"crashes around allocation, launch, termination and settlement preserve one result and one worker"
also crosses a native sleep before settlement.

## 1b Retries and settlement

Expected domain failures can be declared result variants. A task that retries a transient failure must catch it,
record its next checkpoint, and choose its next deadline explicitly. An uncaught error faults the execution once.
Petrus does not retry malformed results or output arcs that throw.
Test: `test/execution.test.ts`
"leaves an uncaught native error faulted instead of adding retries or a result".

Worker completion and net settlement are separate commits. A failed settlement retains the binding and the worker's
terminal outcome. Repair the cause, then use [operator resolution](broken-instances.md); do not rerun external work
merely to retry its output arcs.

## 1c Cancellation and wakeups

A sleeping task can receive cancellation before its deadline. Its abort handler owns the result, if any.
Cancellation after a task chose completion follows the native result race described in [aborts.md](aborts.md).

Sleeps progress only when the Harness schedules tasks. Without `onWake`, Durable manages its timer.
With `onWake`, the host uses `harness.wake()` and resumes scheduling when due.
The authored-start budget does not limit native retries or sleeps.
