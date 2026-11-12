# 1 Native cancellation

`NetInstance.abort(operationId, context)` requests cancellation of the operation's coordinator.
Durable propagates that request through the coordinator's owned execution tree.
The return value `marked` acknowledges a request. It does not promise a domain result named `aborted`.
`terminal` means the coordinator already ended.

## 1a Result precedence

The native execution's abort handler chooses whether to return a declared result. Any declared variant may describe
cancellation. No special name or null value is required. Petrus does not invent a result or refund inputs.
If the execution has no result, the binding remains in flight for [operator resolution](broken-instances.md).

Cancellation before coordinator launch creates no worker. The coordinator ends without a result, retaining the binding.
Test: `test/coordination.test.ts`
"pre-launch cancellation creates no worker and requires an explicit result to release its binding".

A task can choose success and remain `completing` while its children run. A later cancellation can abort those children
without replacing the held success. Business code whose success depends on child outcomes must inspect them before
choosing success. Petrus waits for terminal state before settlement, including during coordinator abort handling.

Tests: `test/execution.test.ts` "keeps the native task's abort result";
`test/aborts.test.ts`
"cancellation while a worker is $mode holds resources until its child terminates and preserves its chosen result".

## 1b Host responsibilities

Abort an existing operation. An unknown operation is an error.
The operation need not declare an `aborted` variant: cancellation without a result is valid but leaves inputs held.
Inspect the terminal task outcome and the committed net result separately.

Native work must observe its cancellation signal. Durable waits for the invocation to stop before its abort handler runs.
Scheduling must run for cancellation to finish. An acknowledged mark alone does not execute an abort handler.

Cancellation does not undo an external effect. A compensating workflow must account for work completed before the
request arrived and for remote work that outlives a process. The host still owns operation cancellation.
This integration adds no net-internal cancellation API.
