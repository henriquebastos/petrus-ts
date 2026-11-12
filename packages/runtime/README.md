# @petrus/runtime

Runs net instances on Pi Durable, one net instance per conversation. An enqueue admits tokens and reserves enabled
bindings with coordinators in one commit. Owned native tasks execute them asynchronously. A retry with the same id
adds nothing, and the same id with other tokens throws. Time comes from an injected clock.

The host installs `@earendil-works/pi-durable` and `@earendil-works/chord` at 1.4.0, the peer dependencies of this
package, so the host and the runtime share one copy of Durable: its Harness, its registry and its error classes.

```ts
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { definitionOrder } from "@petrus/petri-net";
import { createRuntime } from "@petrus/runtime";

const clock = { now: () => Date.now() };
const runtime = createRuntime({
  name: "comment-replies", nonce: randomUUID(), net, policy: definitionOrder, clock, startLimit: 10_000,
});
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

A handler transition declares results and their output arcs. `execution(transition, task)` pairs it with a native
Durable task. The coordinator waits for terminal execution, including ordinary owned children, before settling its result.
Native tasks own retries, sleeps, and abort results. Faults or missing results retain the binding for operator resolution.
Plain transitions use the same lifecycle. Replay uses `runtime.net`, not the unexpanded authored net.

The required `startLimit` bounds authored starts across commits and restarts. Exhaustion pauses whole steps while
existing work can still settle. Inspect `instance.budget()` and explicitly raise the ceiling with `raiseStartLimit`.
Use fresh instances. This model does not migrate old task records.

Pi Durable stores the net instances and runs the operations; it is infrastructure. Modules and exported names use
the words of Petrus: net instance, operation, handler, commit, step. The words of Durable and Chord (document, task,
Session, `Context`) appear only where the code calls them.

- [docs/spec.md](docs/spec.md): terms, guarantees, failures and limits, each with the test that proves it.
- [docs/handlers.md](docs/handlers.md): handler transitions, operations and their tasks, with the same structure.
- [docs/delays.md](docs/delays.md): native sleeps and explicit retries.
- [docs/aborts.md](docs/aborts.md): native cancellation and task-defined results.
- [docs/broken-instances.md](docs/broken-instances.md): bugs in a stored net instance or its net, which the
  runtime does not retry.
- [api/runtime.api.md](api/runtime.api.md): the public signatures. `pnpm lint:api` keeps it current.
