# 1 Faults and operator resolution

An enqueue that fails validation commits nothing. A coordinator whose settlement throws follows Durable's fault
semantics. Its worker's terminal result remains stored, and its binding remains held. Petrus adds no retry loop.

## 1a Fault boundaries

`BrokenNetInstance` identifies a stored marking that does not fit the net, a mismatched net or execution model,
a missing start occurrence, or the 1,000-step transaction limit. Other errors can also fault native execution or
coordination: an uncaught task error, malformed result, or throwing output arc.

A worker fault, orphan, or terminal outcome without a result produces no net output. An invalid declared result
faults coordination rather than calling the worker again. Tests: `test/coordination.test.ts`
"native %s results retain inputs without repeating execution",
"stored malformed native result envelopes fault settlement and retain recoverable inputs".

The start budget is not a fault. It pauses new starts and permits existing operations to settle.
Raise its ceiling explicitly through `raiseStartLimit`; see [spec.md](spec.md).

## 1b Resolution

`resolve(operationId, result, context)` supplies a declared result after the coordinator and worker are terminal.
It refuses live coordination even when the worker already ended. It also refuses a live worker, a missing launch
receipt, or inconsistent ownership. Pre-launch cancellation has an initialized empty receipt and needs no worker.

Resolution validates the result on every call, including duplicates. It admits the first valid result under the
operation's reserved request id, fires output arcs, and allocates permitted downstream work in one transaction.
Repeated or conflicting valid results return the first recorded ingress without new firings.
Resolution preserves both tasks' original outcomes. A failed transaction changes neither the marking nor the budget.

Tests: `test/coordination.test.ts`
"allocation creates one coordinator, launch creates one owned execution, and resolve refuses live coordination",
"pre-launch cancellation creates no worker and requires an explicit result to release its binding",
"a declared result in a native $status outcome settles once".
Tests: `test/coordination.test.ts`
"resolution rejects missing, foreign, mismatched and live workers without changing held inputs",
"equal operation ids in different conversations resolve only their own binding",
"a %s launch receipt cannot release inputs through scheduling or operator resolution";
`test/recovery.test.ts`
"resolve refuses a live coordinator after its worker committed a terminal result before a crash".

## 1c Repair and compatibility

Repair the net or storage before supplying a result. Keep the operation's start occurrence, coordinator record,
launch receipt, and worker record when one exists. An external edit to the instance must clear `stamp` in the same
transaction so the cached marking cannot hide the edit.

Use fresh development instances for this execution model. The instance records `native-v1`, and coordinator task
names include that identity. Old-model instances are rejected, not migrated or silently reinterpreted.
Test: `test/coordination.test.ts` "old execution models cannot reopen as native instances".

Resolution does not restart tasks, undo external effects, or reconstruct missing ownership records.
An operation id is scoped to its conversation. A host must include instance identity in external idempotency keys.
