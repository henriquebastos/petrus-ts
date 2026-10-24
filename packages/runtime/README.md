# @petrus/runtime

Runs one net instance over a store. An enqueue adds a batch of tokens from outside under the host's request id; a
retry with the same id adds nothing, and the same id with other tokens throws. A step selects the binding elements to fire with a selection policy, fires
them together, and commits the new marking and its occurrences in one commit. Time comes from an injected clock,
and calls run one at a time.

```ts
import { definitionOrder } from "@petrus/petri-net";
import { createRuntime } from "@petrus/runtime";

const runtime = createRuntime({ net, store, policy: definitionOrder, clock: { now: () => Date.now() } });
await runtime.enqueue({ requestId: `comment:${String(comment.comment)}`, tokens: { [comments.id]: [comment] } });
const stepped = await runtime.step();
// stepped.fired lists the occurrences it committed; an empty list means nothing was enabled and nothing was committed
```

The request id names the fact (here a comment), not the delivery that brought it, so a redelivery and a poll of
the same comment are one batch. See section 2 of
[examples/comment-replies/README.md](../../examples/comment-replies/README.md).

- [docs/spec.md](docs/spec.md): terms, guarantees, failures and limits, each with the test that proves it.
- [api/runtime.api.md](api/runtime.api.md): the public signatures. `pnpm lint:api` keeps it current.
