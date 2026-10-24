# @petrus/petri-net

A coloured Petri net: typed places, transitions with variables and guards, bindings, markings, the firing rule and
steps.
The package is pure: it has no clock, no disk and no npm dependency.

```ts
import type { ColourSet, Place, Transition } from "@petrus/petri-net";
import { enabledBindings, fire, placeId, transitionId } from "@petrus/petri-net";

const job: ColourSet = { name: "Job", contains: (token) => typeof token === "string" };
const ready: Place = { id: placeId("ready"), colourSet: job };
const done: Place = { id: placeId("done"), colourSet: job };

const finish: Transition<"j"> = {
 id: transitionId("finish"),
 variables: { j: job },
 guard: () => true,
 inputs: [{ place: ready, variables: ["j"] }],
 outputs: [{ place: done, expression: ({ j }) => [j] }],
};

const marking = { [ready.id]: ["job-1", "job-2"] };
enabledBindings(finish, marking); // [{ j: "job-1" }, { j: "job-2" }]

const fired = fire(finish, { j: "job-1" }, marking);
if (fired.ok) {
 // fired.value is { ready: ["job-2"], done: ["job-1"] }
} else {
 // fired.error is not-a-binding (the problems) or not-enabled (the tokens each place lacks)
}
```

`fireStep(net, marking, definitionOrder)` selects and fires a whole step: every enabled binding element, in the
policy's order, whose tokens are still free.

- [docs/spec.md](docs/spec.md): terms, invariants and failures, each with the test that proves it.
- [api/petri-net.api.md](api/petri-net.api.md): the public signatures. `pnpm lint:api` keeps it current.
