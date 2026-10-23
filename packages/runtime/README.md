# @petrus/runtime

Runs one net instance over a store. A step fires one transition and commits the new marking and its occurrence
together. Time comes from an injected clock, and steps run one at a time.

```ts
import { createRuntime } from "@petrus/runtime";

const runtime = createRuntime({ transitions, store, clock: { now: () => Date.now() } });
const stepped = await runtime.step(transitionId("finish"));
if (!stepped.ok) {
 // stepped.error.kind is "not-enabled" or "unknown-transition"; nothing was committed
}
```

- [docs/spec.md](docs/spec.md): terms, guarantees, failures and limits, each with the test that proves it.
- [api/runtime.api.md](api/runtime.api.md): the public signatures. `pnpm lint:api` keeps it current.
