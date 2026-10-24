# Petrus TS

Petrus runs Petri nets as durable programs. A step fires one transition and commits the new marking
and its occurrence in the same commit. The Python Petrus is a separate implementation; nothing is ported from it.

## Status

Walking skeleton. `petri-net` has the firing rule; `runtime` runs steps over a test store, with the seams
(clock, store, serial steps) that a real store will use. Every quality gate has a planted defect in `fixtures/`
and a test in `test/gates/` that shows the gate still fails on it.

## Packages

| Package             | Role                                                         | May import  | Docs                                                                            |
| ------------------- | ------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------- |
| `@petrus/petri-net` | Places, transitions, markings, the firing rule. Pure.        | nothing     | [README](packages/petri-net/README.md), [spec](packages/petri-net/docs/spec.md) |
| `@petrus/runtime`   | Runs one net instance over a store: steps, commits, crashes. | `petri-net` | [README](packages/runtime/README.md), [spec](packages/runtime/docs/spec.md)     |

The layer rules in `.dependency-cruiser.cjs` also name the packages above these:
`hamsterdan`, `hamsterdan-github` and `hamsterdan-cli`, in that order.

## Commands

Requirements: Node 26.8.2 (`.node-version`) and pnpm 11.5.2.

```sh
pnpm install
pnpm feedback      # every gate; run before each commit (about 15 seconds)
pnpm test          # unit and property tests with coverage
pnpm test:gates    # planted defects: each gate must still fail on its fixture
pnpm inspect       # when a change feels done: tests, then Fallow CRAP and clones on the changed files
pnpm periodic      # on demand: Stryker mutation testing, report in reports/mutation/
pnpm format        # format code with Biome and fix Markdown with markdownlint
```

`pnpm feedback` runs, in order: Biome format check, `tsc` 7 on each package and on the tests, ESLint,
dependency-cruiser with the entry-graph budgets, the api-extractor reports, knip, markdownlint, the docs check,
Vitest with coverage, and the gate tests.

`pnpm inspect` runs the tests, then `fallow audit` (config in `.fallowrc.json`) on the files changed since the
merge-base with `main`, uncommitted files included. It fails when the change brings a function in `packages/*/src` to CRAP 10 or more,
and when duplication exceeds 0.1% of the code. knip and dependency-cruiser cover dead code and architecture,
so the audit skips those parts.

`pnpm periodic` runs StrykerJS on `packages/petri-net/src` and `packages/runtime/src` with no score gate.
It is a diagnostic: read the surviving mutants.

## TypeScript versions

`tsc` is TypeScript 7 (package `@typescript/native`). The `typescript` package is an alias of TypeScript 6
(`@typescript/typescript6`), because typescript-eslint, dependency-cruiser and the Stryker TypeScript checker need
the compiler API, which TypeScript 7.0 does not have. api-extractor bundles TypeScript 5.9 and warns about it.
Remove the alias when those tools support TypeScript 7.1.

## Documents

- [AGENTS.md](AGENTS.md): how to change this repository safely, and which doc to read for each topic.
- [docs/style-guide.md](docs/style-guide.md): the code rules that no tool checks.
- Each package has a README and a spec; the package table above links them.
