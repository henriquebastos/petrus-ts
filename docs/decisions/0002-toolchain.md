# 0002 Toolchain and lanes

- Status: accepted, 2026-10-23
- Decided by: Henrique accepted the foundations proposal (conduit `03-expand/foundations/proposal.md`).
  The Driver settled its open choices (proposal 1e2) with trials on copies of this repository.

## Context

The proposal chose the tools and left four questions to evidence: the lint engine, the CRAP tool,
Vitest 4.1 or 5, and the optional compiler flags. Each trial had to show the gate fail on a planted defect
and pass on the real code. The trial reports were in `/tmp/pts-*/TRIAL-REPORT.md` (scratch, not kept).

## Decision

Three lanes, as in pi-fence:

| Lane | Command | When | Tools |
| --- | --- | --- | --- |
| feedback | `pnpm feedback` | before every commit, about 15 s | Biome format check; `tsc` 7 per package and for tooling; ESLint; dependency-cruiser plus entry-graph budgets; api-extractor reports; knip; markdownlint; Vitest with Istanbul coverage and fast-check; gate tests |
| inspect | `pnpm inspect` | when a change feels done | tests, then `fallow audit`: CRAP 30 or more, or duplication above 0.1%, on changed files |
| periodic | `pnpm periodic` | on demand | StrykerJS mutation testing, no score gate |

Choices made by trial:

- **Lint engine: ESLint with typescript-eslint, not oxlint.** Both reported every planted defect, but oxlint only
  with a 47-line local plugin for `no-restricted-syntax` and the eslint-comments plugin loaded through its JS plugin
  interface, which oxlint marks alpha and outside semver. oxlint also obeys `oxlint-disable` comments, a new bypass that
  needs its own rule, and the eslint-comments plugin crashes under oxlint on a broken directive on line 1.
  oxlint saves about 1.4 s per `feedback`. The TS 6 alias stays for dependency-cruiser and api-extractor in any case.
  Revisit when oxlint JS plugins are stable, or when typescript-eslint no longer supports the TypeScript we use.
- **Vitest 4.1.12, not 5.0.5.** StrykerJS vitest-runner 10.0.0 builds test-name filters that Vitest 5 does not match.
  Every mutant then runs no test and is reported Survived, with exit code 0. Move to Vitest 5 when the runner supports it;
  `test/gates/mutation.test.ts` fails if the runner breaks again.
- **CRAP and duplication: Fallow 3.35.0, not crap-score.** crap-score exits 0 at CRAP 72, cannot scope to changed
  functions, has no clone check and adds 374 packages. Fallow's dead-code and architecture checks stay off:
  knip and dependency-cruiser found more on the fixtures.
- **API surface: api-extractor reports in `packages/*/api/`.** A snapshot of `Object.keys` missed new type-only exports
  and changed signatures. Accept an intended API change with `pnpm lint:api --update`.
- **Entry-graph budgets** (`scripts/check-entry-graphs.ts`, run by `lint:deps`), as Pi does: `net` reaches at most
  5 files and no `node:` or npm module; `runtime` at most 8 files and no `node:` module.
- **Compiler flags:** `isolatedDeclarations` and `declaration` on for the packages (root tooling opts out);
  `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch` on.
- **Rejected: type-coverage.** ESLint already fails the planted `as any`, and `--strict` fails the real code on
  lib defaults such as `Iterable<T, any, any>`.
- **Markdown is linted and fixed by markdownlint only.** The Biome 2.6 Markdown formatter removes the blank line
  before a list, which MD032 requires.

## Consequences

- `tsc` is TypeScript 7; the `typescript` package is an alias of TypeScript 6 for the tools that need the compiler API.
  api-extractor bundles TypeScript 5.9 and warns that the project uses 6.0. Remove the alias when the tools support 7.1.
- Fallow's duplication limit is a share of the whole project. Past about 60k lines it no longer catches a 30-line copy;
  lower the threshold then.
- `fallow audit` sees only changes against `main`. A gate test runs `fallow health` and `fallow dupes` on the whole
  repository in `feedback`, so committed code is covered too.
- Stryker uses a fixed fast-check seed and an alias to the mutated `@petrus/net` (`vitest.mutation.config.ts`).
  Without them it silently skips the property tests or loads unmutated code.
- Every gate has a planted defect in `fixtures/` and a test in `test/gates/`. A gate that changes must keep its fixture failing.
