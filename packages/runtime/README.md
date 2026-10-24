# @petrus/runtime

Runs one net instance over a store. A step selects the binding elements to fire with a selection policy, fires them
together, and commits the new marking and its occurrences in one commit. Time comes from an injected clock, and
steps run one at a time.

```ts
import { definitionOrder } from "@petrus/petri-net";
import { createRuntime } from "@petrus/runtime";

const runtime = createRuntime({ net, store, policy: definitionOrder, clock: { now: () => Date.now() } });
const stepped = await runtime.step();
// stepped.fired lists the occurrences it committed; an empty list means nothing was enabled and nothing was committed
```

- [docs/spec.md](docs/spec.md): terms, guarantees, failures and limits, each with the test that proves it.
- [api/runtime.api.md](api/runtime.api.md): the public signatures. `pnpm lint:api` keeps it current.
