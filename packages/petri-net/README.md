# @petrus/petri-net

Places, transitions, markings and the firing rule. The package is pure: it has no clock, no disk and no npm dependency.

```ts
import { fire, placeId, transitionId } from "@petrus/petri-net";

const ready = placeId("ready");
const done = placeId("done");
const finish = { id: transitionId("finish"), inputs: [{ place: ready, weight: 1 }], outputs: [{ place: done, weight: 1 }] };

const fired = fire(finish, { [ready]: 1 });
if (fired.ok) {
 // fired.value is { done: 1 }
} else {
 // fired.error.shortfalls lists each input place that holds too few tokens
}
```

- [docs/spec.md](docs/spec.md): terms, invariants and failures, each with the test that proves it.
- [api/petri-net.api.md](api/petri-net.api.md): the public signatures. `pnpm lint:api` keeps it current.
