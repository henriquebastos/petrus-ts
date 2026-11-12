# Petrus TS

Petrus runs coloured Petri nets as durable programs. Its aim is to coordinate outside work, such as AI agents and
the services they call, as a net: each piece of work is a handler transition, and the log is one timeline of every
change. A host adds tokens from outside under a request id. The
commit that adds them steps the net until the selection policy picks nothing, and holds the new marking with the
occurrences of its steps. It runs on Pi Durable (`@earendil-works/pi-durable`), the durable task and document
library of [Pi](https://github.com/earendil-works/pi). The [Python Petrus](https://github.com/henriquebastos/petrus)
is a separate implementation; nothing is ported from it.

## Status

Early, not released. `petri-net` has coloured nets, bindings with input arc expressions, Jensen steps and
selection policies. `runtime` runs net instances on Pi Durable 1.4.0: enqueues under request ids, handler
transitions as Durable tasks, delayed results, host aborts, and a faulted task when a stored instance is broken.
The clock is a seam. Two examples run on it, with count budgets for scale. Every quality gate has a planted defect
in `fixtures/` and a test in `test/gates/` that shows the gate still fails on it.

Known limits are in the "Limits" sections of the package docs. The open work and the design proposals are the
[GitHub issues](https://github.com/henriquebastos/petrus-ts/issues) of this repository.

## Packages

| Package | Role | May import | Docs |
| ------------------- | ------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| `@petrus/petri-net` | A coloured Petri net: places, bindings, firing. Pure. | nothing | [README](packages/petri-net/README.md), [spec](packages/petri-net/docs/spec.md) |
| `@petrus/runtime` | Net instances on Pi Durable: enqueues, steps, handlers. | `petri-net`, Pi Durable, Chord | [README](packages/runtime/README.md), [spec](packages/runtime/docs/spec.md) |
| `@petrus/net-view-model` | Display data, net projection, marking inspection. | `petri-net`, TypeBox | [README](packages/net-view-model/README.md) |
| `@petrus/net-layout` | Automatic node placement and arc routes. | `net-view-model` types, ELK | [README](packages/net-layout/README.md) |
| `@petrus/runtime-replay` | Runtime log replay through Petrus firing. | `petri-net`, `net-view-model`, `runtime` types | [README](packages/runtime-replay/README.md) |
| `@petrus/net-viewer-react` | Canvas, inspector, replay controls. | `net-view-model`, React, React Flow | [README](packages/net-viewer-react/README.md) |

`examples/comment-replies` is a host app on these packages: GitHub webhook deliveries in, request ids, Durable's
JSONL storage. See its [README](examples/comment-replies/README.md). `examples/classics` runs nets from the
literature with handler transitions and checks each net's invariant at every commit. See its
[README](examples/classics/README.md).
An example imports packages only through their root, and no package imports an example.

The layer rules in `.dependency-cruiser.cjs` also name the packages above these:
`hamsterdan`, `hamsterdan-github` and `hamsterdan-cli`, in that order. They are reserved for a later host
application, a pull-request review app that is on hold. They do not exist in this repository yet. See
[issue #15](https://github.com/henriquebastos/petrus-ts/issues/15).

## Commands

Requirements: Node 26.8.2 (`.node-version`), pnpm 11.5.2 (`npm install -g pnpm@11.5.2`) and git.
`pnpm install` needs the npm registry: it fetches the `@earendil-works/*` 1.4.0 packages.

```sh
pnpm install
pnpm feedback      # every gate; the pre-commit hook runs it (15 to 30 seconds)
pnpm test          # unit and property tests with coverage
pnpm test:gates    # planted defects: each gate must still fail on its fixture
pnpm inspect       # tests, then Fallow CRAP and clones on the changed files; the pre-push hook runs it
pnpm periodic      # Stryker mutation testing, report in reports/mutation/; the pre-push hook runs it
pnpm scale         # time two classical nets at larger sizes (examples/classics/docs/scale.md); not in feedback
pnpm format        # format code with Biome and fix Markdown with markdownlint
```

`pnpm feedback` runs, in order: Biome format check, `tsc` 7 on each package and on the tests, ESLint,
dependency-cruiser with the entry-graph budgets, the api-extractor reports, knip, markdownlint, the docs check,
Vitest with coverage, and the gate tests.

`pnpm inspect` runs the tests, then `fallow audit` (config in `.fallowrc.json`) on the files changed since the
merge-base with `main`, uncommitted files included. It fails when the change brings a function in `packages/*/src` to CRAP 10 or more,
and when duplication exceeds 0.1% of the code. knip and dependency-cruiser cover dead code and architecture,
so the audit skips those parts.

`pnpm periodic` runs StrykerJS on `packages/petri-net/src` and `packages/runtime/src`. It fails below a
mutation score of 100: each surviving mutant needs a test, or a reasoned Stryker disable comment when it is equivalent.
It keeps an incremental file in `reports/mutation/`, which git ignores. A full run, as on a fresh clone and its
first push, takes about 30 minutes; a later run tests only the mutants that a change affects.

`pnpm install` installs the Husky hooks in `.husky/`. `pre-commit` runs `pnpm feedback`. `pre-push` runs
`pnpm inspect` on the commits the push sends, then `pnpm periodic`.

## TypeScript versions

`tsc` is TypeScript 7 (package `@typescript/native`). The `typescript` package is an alias of TypeScript 6
(`@typescript/typescript6`), because typescript-eslint, dependency-cruiser and the Stryker TypeScript checker need
the compiler API, which TypeScript 7.0 does not have. api-extractor bundles TypeScript 5.9 and warns about it.
Remove the alias when those tools support TypeScript 7.1.

## Documents

- [AGENTS.md](AGENTS.md): how to change this repository safely, and which doc to read for each topic.
- [docs/style-guide.md](docs/style-guide.md): the code rules that no tool checks.
- Each package has a README and docs in its `docs/` folder; the package table above links them.
  `AGENTS.md` lists each doc by topic.
