# Petrus TS

Petrus runs Petri nets as durable programs. A net's marking is a durable document; a step fires one transition
and commits the new marking and its occurrence in the same commit. The storage and recovery layer will be
Pi Durable (`@earendil-works/pi-durable`). Hamsterdan, a pull-request readiness app, is the first application.

This repository is new. The Python Petrus is a separate reference implementation; nothing is ported from it by default.

## Status

Walking skeleton. `net` has the firing rule; `runtime` is a stub with the seams (clock, store, serial steps)
that the real runtime will keep. The skeleton exists to prove the toolchain: every quality gate has a planted
defect in `fixtures/` and a test in `test/gates/` that shows the gate still fails on it.

## Packages

| Package           | Role                                                                                      | May import |
| ----------------- | ----------------------------------------------------------------------------------------- | ---------- |
| `@petrus/net`     | Places, transitions, markings, the firing rule. Pure: no clock, no disk, no npm packages. | nothing    |
| `@petrus/runtime` | Runs one net instance over a store: steps, commits, recovery.                             | `net`      |

Later packages, in layer order: `hamsterdan`, `hamsterdan-github`, `hamsterdan-cli`. The layer rules already cover them.

## Commands

Requirements: Node 26.8.2 (`.node-version`) and pnpm 11.5.2.

```sh
pnpm install
pnpm feedback      # every gate; run before each commit (about 7 seconds)
pnpm test          # unit and property tests with coverage
pnpm test:gates    # planted defects: each gate must still fail on its fixture
pnpm format        # format with Biome
```

`pnpm feedback` runs, in order: Biome format check, `tsc` 7 on each package and on the tests, ESLint,
dependency-cruiser, knip, markdownlint, Vitest with coverage, and the gate tests.

## TypeScript versions

`tsc` is TypeScript 7 (package `@typescript/native`). The `typescript` package is an alias of TypeScript 6
(`@typescript/typescript6`), because typescript-eslint, dependency-cruiser and other tools need the compiler API,
which TypeScript 7.0 does not have. Remove the alias when those tools support TypeScript 7.1.

## Documents

- [docs/style-guide.md](docs/style-guide.md): the house rules, with examples from this code.
- [docs/decisions/](docs/decisions/): the decisions that shape the repository.
- Design background: the Obsidian conduit "2026-10-21 Petrus Next" (dossier and `03-expand/foundations/`).
