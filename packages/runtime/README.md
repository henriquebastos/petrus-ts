# @petrus/runtime

Runs net instances on Pi Durable, one net instance per conversation. An enqueue adds a batch of tokens from outside
under the host's request id, and steps the net until the selection policy selects nothing, in the same commit. A
retry with the same id adds nothing, and the same id with other tokens throws. Time comes from an injected clock.

The host installs `@earendil-works/pi-durable` and `@earendil-works/chord` at 1.4.0, the peer dependencies of this
package, so the host and the runtime share one copy of Durable: its Harness, its registry and its error classes.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { definitionOrder } from "@petrus/petri-net";
import { createRuntime } from "@petrus/runtime";

const clock = { now: () => Date.now() };
const runtime = createRuntime({ name: "comment-replies", net, policy: definitionOrder, clock, retryDelayMs: 1_000 });
const registry = createRegistry();
registry.install(runtime.extension);
const harness = await Harness.open(storage, { models, registry, now: clock.now }, BACKGROUND_CONTEXT);
harness.resume(); // no task runs before this call; waitForIdle or waitForTask waits for tasks
const instance = runtime.instance(harness, (await harness.root(BACKGROUND_CONTEXT)).id);
const batch = { requestId: `comment:${String(comment.comment)}`, tokens: { [comments.id]: [comment] } };
const { ingress, fired } = await instance.enqueue(batch, BACKGROUND_CONTEXT);
// fired lists the occurrences of the commit; a batch sent again returns the recorded ingress and fires nothing
```

The request id names the fact (here a comment), not the delivery that brought it, so a redelivery and a poll of
the same comment are one batch. See section 2 of
[examples/comment-replies/README.md](../../examples/comment-replies/README.md).

A handler transition starts work outside the net, such as a call to a service. Each operation runs as a Durable
task. The task runs the handler, records the result under the operation's id, and steps the net until it is quiet.
After a crash the task runs the handler again, and each result counts once.

Pi Durable stores the net instances and runs the operations; it is infrastructure. Modules and exported names use
the words of Petrus: net instance, operation, handler, commit, step. The words of Durable and Chord (document, task,
Session, `Context`) appear only where the code calls them.

- [docs/spec.md](docs/spec.md): terms, guarantees, failures and limits, each with the test that proves it.
- [docs/handlers.md](docs/handlers.md): handler transitions, operations and their tasks, with the same structure.
- [docs/delays.md](docs/delays.md): delayed results, which wait on a Durable sleep.
- [docs/aborts.md](docs/aborts.md): host aborts, which end an operation with its variant `aborted`.
- [docs/broken-instances.md](docs/broken-instances.md): bugs in a stored net instance or its net, which the
  runtime does not retry.
- [api/runtime.api.md](api/runtime.api.md): the public signatures. `pnpm lint:api` keeps it current.
