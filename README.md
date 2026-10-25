# Petrus TS

Petrus runs coloured Petri nets as durable programs. A host adds tokens from outside under a request id. The
commit that adds them steps the net until the selection policy picks nothing, and holds the new marking with the
occurrences of its steps. The Python Petrus is a separate implementation; nothing is ported from it.

## Status

Walking skeleton. `petri-net` has the firing rule; `runtime` runs net instances and handlers on Pi Durable 1.4.0,
with the clock as a seam. Each operation runs as a Durable task in the host's process. Every quality gate has a
planted defect in `fixtures/` and a test in `test/gates/` that shows the gate still fails on it.

## Packages

| Package             | Role                                                    | May import              | Docs                                                                            |
| ------------------- | ------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `@petrus/petri-net` | A coloured Petri net: places, bindings, firing. Pure.   | nothing                 | [README](packages/petri-net/README.md), [spec](packages/petri-net/docs/spec.md) |
| `@petrus/runtime`   | Net instances on Pi Durable: enqueues, steps, handlers. | `petri-net`, Pi Durable | [README](packages/runtime/README.md), [spec](packages/runtime/docs/spec.md)     |

`examples/comment-replies` is a host app on these packages: GitHub webhook deliveries in, request ids, Durable's
JSONL storage. See its [README](examples/comment-replies/README.md). `examples/classics` runs nets from the
literature with handler transitions and checks each net's invariant at every commit. See its
[README](examples/classics/README.md).
An example imports packages only through their root, and no package imports an example.

The layer rules in `.dependency-cruiser.cjs` also name the packages above these:
`hamsterdan`, `hamsterdan-github` and `hamsterdan-cli`, in that order.

## Commands

Requirements: Node 26.8.2 (`.node-version`) and pnpm 11.5.2.

```sh
pnpm install
pnpm feedback      # every gate; the pre-commit hook runs it (about 15 seconds)
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
- Each package has a README and a spec; the package table above links them.
