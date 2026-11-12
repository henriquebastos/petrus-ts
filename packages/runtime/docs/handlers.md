# 1 Native executions and handler transitions

An authored transition reserves its inputs and creates a coordinator in one transaction. The coordinator launches
one owned native Durable task. It admits that task's declared result only after the task becomes terminal.
Internal start and end transitions do not create execution tasks of their own.

## 1a Authoring

`HandlerTransition` in `src/handlers.ts` declares variables, a guard, input arcs, and result variants.
Each variant has a value colour set and output arcs that read the original binding and the result value.
`HandlerResult` is `{ variant, value }`.

`execution(transition, task)` in `src/execution.ts` pairs that declaration with a native Durable task.
The task receives `ExecutionInput`: `{ id, transition, binding, startedAt }`.
Its phases and checkpoint types remain native. Executions with different checkpoint unions and hooks can share
one runtime without casts. Install native child task definitions in the Harness registry too.
Task names must be unique in that registry.

Test: `test/execution.test.ts`
"registers unrelated native tasks and preserves their input, ownership, checkpoints and results".

The task owns retries, sleeps, children, and abort behavior. Petrus adds neither automatic retries nor a cancellation
result. An uncaught native error faults the execution. A completed, failed, or aborted outcome can carry a declared
result. A missing result, fault, or orphan leaves the binding unresolved.
Tests: `test/execution.test.ts` "keeps the native task's abort result",
"leaves an uncaught native error faulted instead of adding retries or a result".

Plain transitions in `RuntimeOptions.net` also use this lifecycle. A minimal native task returns the unit result
`done`; settlement evaluates the original output arcs. `runtime.net` is the expanded net for replay and inspection.

## 1b The expanded net

`withHandlers(net, transitions)` is a pure expansion. Each transition `t` becomes:

- A start `t` with the original variables, guard, input arcs, and declared join keys. Its output stores the binding on `t:busy`.
- A place `t:result` for `{ binding, variant, value }`.
- An end `t:v` for each declared variant `v`. It consumes the matching busy binding and result, then produces the variant's outputs.

End transitions join busy bindings to results. Their occurrence bindings remain `{busy, result}`.
The pure engine remains the replay oracle.
Tests: `test/handlers.test.ts`
"makes a handler transition a start transition, a busy place, a result place and an end per variant",
"the busy place holds only bindings of the transition, and the result place only declared results",
"an end fires only for a result of its own variant and its own run",
"handler joins preserve matching results and busy arrival order",
"one handler result checks only its matching run, regardless of the number of busy runs".

## 1c Atomic boundaries

- Allocation consumes inputs, appends start occurrences, charges the start budget, and creates coordinators together.
- Launch creates one owned worker, records its launch receipt, and stores an `allSettled` wait together.
- Native task phases perform the work. `completing` does not release tokens: ordinary owned children must end first.
- Settlement validates the terminal result, admits `result:<operation id>`, fires internal ends, and allocates permitted downstream starts.
  The coordinator ends in that transaction.

An operation id is `transition/<start occurrence log index>`. It is unique within one instance, not across conversations.
External services need this id together with the instance identity for idempotency or fencing.
Task invocation can repeat after a crash. A retained terminal execution is not rerun merely because settlement failed.

Terminal task records discard checkpoints. A conversation-scoped `petrus.native-launch` document retains each
coordinator's worker reference. Allocation creates an initialized empty receipt; launch fills it atomically.
Recovery checks the retained task's owner, conversation, and input. A missing receipt or inconsistent worker is an error.

Tests: `test/coordination.test.ts`
"allocation creates one coordinator, launch creates one owned execution, and resolve refuses live coordination",
"crashes around allocation, launch, termination and settlement preserve one result and one worker".
The classical test `examples/classics/test/mutual-exclusion.test.ts`
"holds the mutex through native completion and both owned children, under generated completion orders and crashes"
checks held resources and expanded-net replay with two owned children.

## 1d Settlement and limits

Internal ends settle before policy-selected starts. A paused start budget cannot prevent existing operations from
settling. Result validation also runs for duplicates. The first recorded result wins.
Host requests cannot use `result:` or `start-limit:` prefixes or fill internal busy and result places.

See [spec.md](spec.md) for the durable start budget, [aborts.md](aborts.md) for cancellation,
[delays.md](delays.md) for native sleeps, and [broken-instances.md](broken-instances.md) for operator resolution.

A resource token prevents overlapping operations within the net. It cannot stop an external effect that survives
a dead process. Such a resource needs its own lease or fence. The start budget does not bound native child creation,
explicit retries, or external spending.
