# Handler transitions

The core rule:

> A handler transition fires like any transition and starts an operation. Its handler does the work outside the
> net. The result goes on the transition's result place under the request id `result:<operation id>`, and a step
> fires the end transition of the result's variant. The first result of an operation counts. `settle` runs the
> handler of every operation that the stored log started and has no result for, so after a crash the work in
> flight runs again and ends once.

## 1 Terms

- A **handler transition** (`HandlerTransition` in `src/handlers.ts`) has variables, a guard and input arcs like a
  transition, but no output arcs. It has **variants** instead: each one names a way the work can end, the colour
  set of its **value**, and output arcs whose expressions read the binding and the value.
- A **handler** (`Handler`) is a handler transition with `run(binding, { operationId })`, which returns a
  **result** `{ variant, value }`. An expected failure is a variant; a throw means a bug or an outage.
- `withHandlers(net, transitions)` returns the **plain net** that a net with handler transitions is short for. Each
  handler transition `t` becomes:
  - the transition `t`, with the same variables, guard and inputs, whose output arc puts the binding on `t:busy`;
  - the place `t:result`, which holds result tokens `{ binding, variant, value }`;
  - for each variant `v`, the transition `t:v`, which takes a binding from `t:busy` and a result with variant `v`
    for that binding from `t:result`, and produces the variant's outputs.

  The input tokens stay taken while the work runs, so a resource token is held for the whole work. The runtime
  runs the plain net, so the net checks and the replay are those of the petri-net spec.
- An **operation** is the work that one occurrence of `t` started. Its id is `t/<position of the occurrence in the
  log>`, so it stays the same after a restart. It is **in flight** until the log holds its result.
- `complete(operationId, result)` puts the result token on `t:result` and records its ingress, in one commit.
  `inFlight()` lists the operations in flight. `step` fires `t` but runs no handler.
- `settle()` runs the handler of each operation in flight, completes it, and steps, until a step fires nothing
  and no handler runs. Settles of one runtime share their runs.

## 2 Guarantees

Each guarantee names the test that proves it. Paths are relative to this package.

- `withHandlers` adds the parts above with no net problems. Only the end of the result's variant fires.
  Tests: `test/handlers.test.ts` "makes a handler transition a start transition, a busy place, a result place and
  an end per variant", "the start puts the binding on the busy place, and the end of its variant produces the
  outputs".
- The busy place holds only bindings of the transition. The result place holds only results with a declared
  variant, a value of that variant's colour set, and a binding of the transition.
  Test: `test/handlers.test.ts` "the busy place holds only bindings of the transition, and the result place only
  declared results".
- An end fires only for a result of its own variant and binding, in any key order.
  Test: `test/handlers.test.ts` "an end fires only for a result of its own variant and its own run".
- An operation's id is its transition and its position in the log, and it is in flight until the log holds its
  result. Tests: `test/handlers.test.ts` "names each operation by its transition and its position in the log",
  "an operation is in flight until the log holds its result".
- The first result of an operation counts: a later one returns the recorded ingress.
  Tests: `test/handlers.test.ts` "puts a result on the result place under the operation's request id; the first
  result counts", "a step starts an operation but runs no handler; complete records its result and a step ends it".
- `settle` runs every handler, records each result, and steps until the net is quiet.
  Test: `test/handlers.test.ts` "settle runs every handler, records each result, and steps until the net is quiet".
- After one store fault at any commit of a settle (a crash before or after the commit lands, a lost reply, or a
  failed commit) and one handler outage, and a new runtime after a crash or a new settle after the other faults: the stored marking is
  the replay of the stored log, each job ran once in the net and ended, each operation has one result under its
  own request id, the outside service did no work for an operation that the store does not hold, and no handler
  ran before the step that started it was stored.
  Test: `test/handlers.test.ts` "each job ends once after a crash, a lost reply or a failed commit at any commit of
  a settle", with `handlerFaultProperty` in `test/handler-properties.ts`.
- With up to three settles that start at any time, a late batch, one handler outage, and any order of store and
  handler answers, the same holds: the outage makes exactly one settle reject, each operation's handler ran once
  (the failed one twice), and a resource place with two tokens kept at most two handlers running at once.
  Test: `test/handlers.test.ts` "concurrent settles run each operation once, under any order of the store and the
  handlers", with `handlerRaceProperty` in `test/handler-properties.ts`.
- A lost reply on a result commit does not run the handler again: the next settle finds the result in the log.
  Test: `test/handlers.test.ts` "after a lost reply on a result, the next settle ends the operation without running
  it again".

The simulation gate test shows that the two properties fail on five planted defects in `fixtures/simulation/`: a settle that forgets the operations it did not start, a handler run before its step is
stored, two settles that run one operation twice, a result under a request id that is not the operation's, and a
runtime that never runs an operation again after its handler threw.

## 3 Failures

- A handler throws, or its result does not commit: the settle rejects with that error, the operation stays in
  flight, and the next settle runs it again. One settle reports each failed run; another settle that waits on the
  same run goes on and runs it again.
  Tests: `test/handlers.test.ts` "a settle reports a handler's error; the operation stays in flight, and the next
  settle runs it again", "one settle reports a failed run; another settle that waits on it runs it again".
- A host batch whose request id starts with `result:`, or that has tokens on a busy or result place, is a bug in
  the host: the enqueue rejects and commits nothing.
  Tests: `test/handlers.test.ts` "refuses a host batch that uses a result request id or fills a place the runtime
  owns, and commits nothing", "a host's batch may not use a result request id or fill a place that the runtime owns".
- A result for no started operation, or one that does not fit the transition, is a bug in the handler, also when
  the log already holds a result for the operation.
  Test: `test/handlers.test.ts` "refuses a result for no started operation, or one the transition does not
  declare, which is a bug".
- A handler transition whose parts clash with the net, such as a place named `t:busy`, is a net problem.
  Test: `test/handlers.test.ts` "refuses a handler transition whose parts clash with the net, and names every
  problem".
- An operation with no handler makes each settle reject. An end's arc that gets a token outside its places is a
  bug in the runtime, so it throws.
  Tests: `test/handlers.test.ts` "rejects when no handler runs an operation, and leaves it to the next settle",
  "an end's arcs throw on a token outside their places, which is a bug in the runtime".

## 4 What a handler must do

- Expect to run more than once for one operation, after a crash or a result that did not commit. Give
  `operationId` to the outside service, so that a second run finds what the first did. The id is unique only in
  one net instance; a host adds the instance's name.
- Return an expected failure as a variant, and throw only for a bug or an outage.

## 5 Limits

- Handlers run in the runtime's process.
- A handler has no abort and no timeout. A settle waits for each handler it runs.
- A net that never stops firing makes `settle` run forever.
- Each runtime keeps the id of each operation it ran, so that a stale list cannot start it twice. The set only
  grows.
- Each round of a settle reads the whole log to find the operations in flight, so a long settle costs time in
  proportion to the square of the log's length.
- One runtime at a time uses a store, as in the spec.
