# 1 Runtime specification

An enqueue atomically admits tokens and reserves enabled authored bindings with their coordinators.
Each coordinator launches one owned native execution task. Settlement publishes a declared result only after that task becomes terminal.
Enqueue acknowledges admission, not downstream completion.

## 1a State and authoring

A net instance belongs to one Durable conversation. Its public state is a marking and a log.
The log retains ingress and occurrence event shapes. Each ingress records a request id, tokens, and time.
Each occurrence records a transition, binding, and time. A commit's occurrences share a timestamp and retain firing order.
Replay uses the expanded `runtime.net`, including internal start and end transitions.

`createRuntime({ name, nonce, net, policy, clock, executions, startLimit })` returns `{ net, extension, instance }`.
Install the extension before opening the Harness. Register native child definitions too.
Runtime names and native task names must be unique in the registry.
The runtime and Harness share one clock. Give each runtime object a fresh nonce, including after restart.

Authored plain transitions use minimal native tasks. Executions pair handler declarations with native tasks.
See [handlers.md](handlers.md) for authoring and atomic boundaries.
The selection policy controls authored starts. Internal ends settle first, independently of that policy.
Thus a commit can have no more starts while execution tasks remain pending, sleeping, or unresolved.

Test: `test/coordination.test.ts`
"allocation creates one coordinator, launch creates one owned execution, and resolve refuses live coordination".

## 1b Durable start budget

`startLimit` is a required nonnegative safe integer. It initializes a per-instance ceiling on committed authored starts.
The stored ceiling and usage survive reopen. New runtime options do not reset them.
`budget(context)` returns `{ ceiling, used, paused }` separately from the marking and log.

When allocation exceeds remaining credit, the runtime refuses the whole step. It reserves no binding in that step.
The current admission or settlement still commits. New starts pause durably, but in-flight operations may settle.
This pause is not a fault and does not imply that the net has no enabled bindings.

`raiseStartLimit(ceiling, context)` explicitly raises the absolute ceiling and resumes allocation.
It records an empty ingress under `start-limit:<ceiling>`. Repeated or concurrent calls with that ceiling grant no extra credit.
A lower, previously unrecorded ceiling is an error. A repeat of a recorded increase remains idempotent.
The existing 1,000-step transaction limit also remains.

Tests: `test/coordination.test.ts`
"pure work schedules tasks and a durable ceiling stops cycles across reopen and idempotent increases",
"a step over budget reserves none of its bindings and pausing still lets existing work settle".
The budget bounds net-driven cycles, not native retries, child creation, or external spending.

## 1c Storage and cache

The `petrus.net-instance` document keeps its latest value. The log supplies history. Forks start empty.
Version 1 uses 1024 sorted ingress buckets, a marking journal, a cache stamp, a budget, and model `native-v1`.
There is no migration. Old execution models must use fresh instances.
Tests: `test/net-instance-record.test.ts` "has one version and no migration";
`test/coordination.test.ts` "old execution models cannot reopen as native instances".

Each runtime caches up to eight indexed markings, evicting the least recently used instance.
This bounds instance count, not bytes. Matching stamps reuse an index. Cache misses rebuild and validate it.
Taking an index removes it from the cache. An aborted transaction cannot reuse the uncommitted stamp.
An external writer must clear the stamp in the same transaction as its edit.

Tests: `test/net-instance-cache.test.ts`
"the default cache retains eight instances and putting an existing entry refreshes its recency",
"cached and rebuilt commits preserve the oracle's state and JSON key order",
"a transaction aborted after the journal write cannot reuse the uncommitted index",
"matching stamps avoid marking reads for new and repeated batches",
"a foreign writer's stamp rebuilds the index even when the log length is unchanged".

## 1d Admission and recovery

`enqueue(batch, context)` returns the ingress and occurrences committed by that admission.
A repeated request with equal tokens returns its recorded ingress and fires nothing.
Place-key order does not matter. Token order within a place does.
Invalid tokens or a repeated request with different tokens reject without committing.
Tests: `test/admit.test.ts`
"returns the recorded ingress for a request id the log holds, whatever the order of its places",
"counts the order of tokens on a place, so the same id with the tokens reordered is other tokens",
"refuses a batch that does not fit the net, even under a recorded request id".

`state` reads committed marking and log. `inFlight` lists starts with no recorded result.
After a storage failure, the host redelivers the same request: acknowledgment may have been lost after commit.
Every committed marking must equal expanded-net replay.
Test: `test/coordination.test.ts`
"crashes around allocation, launch, termination and settlement preserve one result and one worker".

Cancellation follows native ownership and task-defined outcomes, as [aborts.md](aborts.md) specifies.
`resolve` requires terminal coordination and terminal execution, if launched. It preserves task outcomes and validates duplicates.
See [broken-instances.md](broken-instances.md). Native tasks own sleeps and explicit retries, as [delays.md](delays.md) specifies.

## 1e Limits

The log and launch receipts grow with operations. `state`, `inFlight`, and `abort` read the log.
Recovery scans paginated task records. Policies still inspect enabled bindings and have no persistent fairness state.
Two native tasks per authored operation add scheduling and storage work. This contract makes no new latency guarantee.
