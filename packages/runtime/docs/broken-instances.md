# Broken net instances

The core rule:

> A broken net instance is a bug that the runtime finds in a stored net instance or in its net. A commit with the
> same input throws it again, so the runtime does not retry it: an enqueue rejects, and a handler task ends as
> faulted. Its operation stays in flight until an operator supplies a valid result after repairing the cause.

## 1 Terms

- A commit finds a **broken net instance** (`BrokenNetInstance` in `src/net-instance.ts`) when:
  - the net does not become quiet in `stepLimit` (1,000) steps;
  - the conversation holds an instance of another net;
  - the stored marking does not fit the net (see `markingProblems`);
  - a result names an operation that the log did not start.
- Other throws are not broken net instances, and a handler task retries them after `retryDelayMs`: a handler's
  throw, a transition with no handler, a result or a delay that does not fit, an arc that throws, and a
  `StorageRequestError`. See section 3 of [handlers.md](handlers.md) and section 3 of [delays.md](delays.md).
  Any other store failure fails the Durable Session, so the task stops with no report and no retry.

## 2 Guarantees

Paths are relative to this package.

- An enqueue that finds a broken net instance rejects and commits nothing. Tests: `test/runtime.test.ts` "refuses a
  net that can still fire after stepLimit steps, which is a bug in the net, and commits nothing", "refuses a
  conversation that holds an instance of another net, which is a bug in the host", "refuses a stored marking that
  does not fit the net, which is a bug in the store".
- When the result's commit of a handler task finds a broken net instance, the task ends as faulted, with no retry.
  Durable reports the error once, and `waitForIdle` returns. The commit records nothing, so the operation stays in
  flight with its input tokens taken. Tests: `test/handlers.test.ts` "a net that does not become quiet after a
  result ends the task faulted, reported once, and the operation stays in flight", "a stored log that names no
  started operation ends the task faulted, reported once, with nothing committed", "an instance of another net
  ends the task faulted, reported once, and the operation stays in flight", "a stored marking that does not fit
  the net ends the task faulted, reported once, and the operation stays in flight".
- The same holds for the commit of a delayed result in the `due` phase, and the handler does not run again.
  Test: `test/delays.test.ts` "a broken net instance in the commit of a due result ends the task faulted, reported
  once, with no new run of the handler".
- An abort's commit ends its task as faulted on any throw. See section 3 of [aborts.md](aborts.md).
- `NetInstance.resolve(operationId, result, context)` records an operator's supplied `HandlerResult` after the
  operation's task has ended. It returns `{ ingress, fired }`, like `enqueue`. The commit checks the task's state
  through Durable's transaction before it admits the result. It steps the net and starts any new operations in
  that same commit. Pending, running, waiting, and sleeping tasks cannot be resolved. Test:
  `test/recovery.test.ts` "refuses pending, running and sleeping tasks before recording a supplied result".
- A valid result counts once, under `result:<operation id>`. Concurrent or repeated calls return the first ingress
  and no new firings. The task keeps its original terminal outcome. Tests: `test/recovery.test.ts`
  "repairs a faulted operation and resolves its result once without restarting its task",
  "refuses invalid results and unknown operations without changing a terminal operation".
- A failed resolution transaction changes neither the marking nor the task. A retry releases the tokens once,
  including after an abort with no result. Test: `test/recovery.test.ts`
  "a failed resolution commits nothing and a retry releases an aborted operation's tokens once".
- Resolution rejects an unknown operation or an invalid result without changing the instance. It validates the
  result even when the log already holds a result. Test: `test/recovery.test.ts`
  "refuses invalid results and unknown operations without changing a terminal operation".
- A step-limit fault stays terminal in both `run` and `due`. Resolution can supply a corrected result without
  running the handler again. A resolution that exceeds the step limit rejects without committing. Test:
  `test/recovery.test.ts` "a step-limit fault accepts a corrected result without retrying the handler (delayed=%s)".

The simulation gate runs the other-net case of the handler tests on a planted runtime whose task retries every
throw (`fixtures/simulation/retry-every-throw-runtime.ts`). Its task reports the same bug after each retry delay
and never ends.

## 3 Recovery

Repair the net or the store before calling `resolve`. An external edit to the stored instance must clear its
`stamp` in the same transaction, so the runtime rebuilds its cached marking. Keep the operation's start in the
log and its task record. Supply a result whose variant and value fit the repaired net. The result's arcs release
the resources held by the operation. Resolution does not call the handler or undo work in an outside service.

## 4 Limits

- A repaired net or store does not restart a faulted task. `Harness.retryTask` applies to parked tasks, not ended
  tasks. `abort` returns `terminal` for an ended task. Recovery requires an explicit `resolve` call.
- A step-limit fault in `run` remains terminal even if another handler run could return a different result.
  This prevents deterministic results from retrying forever. An operator must choose the corrected result.
- Resolution requires the operation's task record. It does not recreate a lost task or repair a lost log entry.
