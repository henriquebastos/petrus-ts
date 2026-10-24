# Handler transitions

The core rule:

> A handler transition fires like any transition and starts an operation, and the same commit creates the
> operation's task. The task runs the handler outside the net. Then one commit puts the result on the transition's
> result place under the request id `result:<operation id>`, steps the net until it is quiet, and ends the task.
> After a throw or a crash the handler runs again: it runs at least once, and only its first result counts.

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
  `inFlight(context)` lists the operations in flight, in log order.
- A **handler task** runs one operation. It is a Durable task of kind `petrus.operation:<net name>` in the net
  instance's conversation; the `extension` of `createRuntime` holds this kind. Its phase `run` calls the
  handler with the operation's binding and id. Then one commit records the result, steps the net, and ends the
  task as `completed`. Its time comes from the Harness's clock. A handler can also return a
  **delayed result**: see [delays.md](delays.md).
- When a phase throws, the task reports the error (`onReport`), sleeps for `retryDelayMs`, and runs the phase
  again. The operation stays in flight.
- No task runs until the host calls `harness.resume()`.

## 2 Guarantees

Paths are relative to this package.

- `withHandlers` adds the parts above with no net problems.
  Test: `test/handlers.test.ts` "makes a handler transition a start transition, a busy place, a result place and
  an end per variant".
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
  Test: `test/handlers.test.ts` "puts a result on the result place under the operation's request id; the first
  result counts".
- A commit that fires a handler transition creates the operation's task, and runs no handler. The task runs the
  handler, records the result, and steps the net until it is quiet. The handler's variant chooses the end.
  Tests: `test/handlers.test.ts` "an enqueue starts an operation and creates its task in one commit; the task runs
  the handler, records its result and steps until quiet", "the handler tasks end every operation by the variant
  that its handler returns".
- An aborted task ends as `aborted`, also while its handler runs: no result is recorded and nothing is reported.
  Tests: `test/handlers.test.ts` "aborting a handler task ends it as aborted without
  running the handler, and its operation stays in flight", "aborting a task while its handler runs ends it as
  aborted, records no result and reports nothing".
- A process dies before or after any storage commit lands, and the service has one outage. A new process
  enqueues the first batch again and runs the tasks. At every commit the marking is the replay of the log
  and the net is quiet. Each job ended once. Each operation has one result, under its own
  request id. The service did no work for an operation that the log does not hold, and no handler ran before the
  commit of its occurrence landed. Test: `test/handlers.test.ts` "each job ends once after a crash before or after
  any commit, and after the service's outage", with `handlerFaultProperty` in `test/handler-properties.ts`.
- With a late batch and handler runs that end in any order, the same holds. The outage is reported once. Each
  operation's handler ran once, and the one with the outage twice. At most two handlers ran at once. Test:
  `test/handlers.test.ts` "each operation runs once, at most two at once, under any order of handler ends and a
  late batch", with `handlerRaceProperty` in `test/handler-properties.ts`.

The simulation gate shows that `handlerFaultProperty` fails on four planted defects: a handler runs before its
commit lands (`fixtures/simulation/early-start-runtime.ts`), tasks come in a second commit
(`fixtures/simulation/late-task-runtime.ts`), a result has another request id
(`fixtures/simulation/timed-result-runtime.ts`), and a throw ends the task faulted
(`fixtures/simulation/uncaught-throw-runtime.ts`).

## 3 Failures

- A handler throws, the operation's transition has no handler, or the result's commit throws: the task reports
  the error and runs again after `retryDelayMs`.
  Tests: `test/handlers.test.ts` "a handler's throw is reported, and the operation stays in flight and runs again
  after retryDelayMs", "a task whose transition has no handler, as after the host dropped it, is reported and runs
  again after retryDelayMs".
- A result for no started operation, or one that does not fit the transition, is a bug, also when the log holds
  a result for the operation. Its commit throws.
  Test: `test/handlers.test.ts` "refuses a result for no started operation, or one the transition does not
  declare, which is a bug".
- A host batch whose request id starts with `result:`, or that has tokens on a busy or result place, is a bug in
  the host: the enqueue rejects and commits nothing.
  Test: `test/handlers.test.ts` "refuses a host batch that uses a result request id or fills a place the runtime
  owns, and commits nothing".
- A handler transition whose parts clash with the net, such as a place named `t:busy`, is a net problem.
  Test: `test/handlers.test.ts` "refuses a handler transition whose parts clash with the net, and names every
  problem".
- An end's arc that gets a token outside its places is a bug in the runtime, so it throws.
  Test: `test/handlers.test.ts` "an end's arcs throw on a token outside their places, which is a bug in the
  runtime".

## 4 What a handler must do

- Expect to run more than once for one operation: after a crash, a throw, or a result that did not commit. Give
  `operationId` to the outside service, so that a second run finds what the first did. The id is unique only in
  one net instance; a host adds the net's name and the conversation id.
- Return an expected failure as a variant, and throw only for a bug or an outage.

## 5 Limits

- Handlers run in the process of the Harness.
- A resource token keeps work exclusive only inside the net. If a process dies while its handler's work goes on,
  the next run of the operation can overlap it: two holders are inside at once. See section 5 of
  [examples/classics/README.md](../../../examples/classics/README.md).
- A handler has no timeout. A wait inside a handler does not survive a crash; a delayed result does.
- An aborted task leaves its operation in flight for ever, with its input tokens taken.
- Durable parks a task that a crash cuts off `restartLimit` times in a row (default 5). Its operation stays in
  flight until the host calls `Harness.retryTask`.
- A throw that comes back each time, such as a result that does not fit or a net that does not become quiet in
  1,000 steps, makes the task run again after each `retryDelayMs`, with no limit.
- Each commit reads the whole log, so its cost grows with the log.
