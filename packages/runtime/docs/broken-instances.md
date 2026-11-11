# Broken net instances

The core rule:

> A broken net instance is a bug that the runtime finds in a stored net instance or in its net. A commit with the
> same input throws it again, so the runtime does not retry it: an enqueue rejects, and a handler task ends as
> faulted. Its operation stays in flight.

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

The simulation gate runs the other-net case of the handler tests on a planted runtime whose task retries every
throw (`fixtures/simulation/retry-every-throw-runtime.ts`). Its task reports the same bug after each retry delay
and never ends.

## 3 Limits

- Nothing ends the operation of a faulted task. It stays in flight for ever, with its input tokens taken.
- A fixed net or store does not resume a faulted task: `Harness.retryTask` does nothing for a task that has ended,
  and `abort` returns `terminal`.
- In the `run` phase, a net that does not become quiet for one handler result ends the task as faulted, also when
  a new run of the handler could return another result.
