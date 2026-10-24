# Agent instructions

Read `README.md` first. Then read the doc for the topic you change, in full:

| Topic                                                 | Read                                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Colour sets, bindings, markings, firing, validation   | `packages/petri-net/docs/spec.md`                                                            |
| Enqueues, commits, steps, crashes, concurrency        | `packages/runtime/docs/spec.md`                                                              |
| Handler transitions, operations, handler tasks        | `packages/runtime/docs/handlers.md`                                                          |
| A host app: request ids, the edge, a Harness, storage | `examples/comment-replies/README.md`                                                         |
| Classical nets with handlers and their invariants     | `examples/classics/README.md`                                                                |
| Code style                                            | `docs/style-guide.md`                                                                        |
| A lint, type, dependency or test gate                 | the config file and its comments, the gate test in `test/gates/`, its fixture in `fixtures/` |

## Done means green

- Run `pnpm feedback` before you say a change is done. Report the result.
- A behaviour change comes with a test that fails without it. Prefer a fast-check property when a rule holds for all inputs.
- Run `pnpm format` to format. Do not format by hand.
- A change to a package's public API fails `lint:api`. If the change is intended, run `pnpm lint:api --update` and commit the report diff in `packages/*/api/`.
- The pre-commit hook runs `pnpm feedback`, and the pre-push hook runs `pnpm inspect` (CRAP and duplication on the pushed
  commits) and `pnpm periodic` (mutation testing, break score 100). Do not skip them with `--no-verify`.
  Run `pnpm periodic` yourself after a change to `petri-net` or `runtime` logic, and read the surviving mutants.

## Docs

- Docs describe the code as it is now. Change a doc in the same commit as the code it describes.
  Delete text that is no longer true; git keeps the history. There are no decision records, plans or worklogs here.
- Put a reason as close to the code as possible: a test that fails is best, then the tool's error message,
  then a comment at the setting. Write a doc only for what spans many files.
- A spec names the test that proves each invariant, as a path and the test title in quotes.
- Docs name only files in this repository, and each Markdown file has at most 1,500 words.
  `pnpm lint:docs` checks the paths, the cited test titles, the word limit and references to places outside the repository.

## Rules that are easy to break

- `fixtures/` holds planted defects. Each file must keep failing its gate. Do not fix, format or lint-clean it.
  When you change a gate config, update the fixture and its expected output in the same change.
- `packages/petri-net` stays pure: no Node builtins, no npm packages, no time, no randomness. It must run anywhere.
- Code in `packages/*/src` gets time, timers and randomness from injected seams, never from `Date`, `setTimeout` or
  `Math.random`, so tests and simulations control them.
- Import another package only through its root (`@petrus/petri-net`), and only from a lower layer.
- Every `eslint-disable` and `@ts-expect-error` has a reason on the same line, after `--`.
- Parse untrusted input with a TypeBox schema, the schema library Pi uses. `scripts/json.ts` has `parseJson`.
  Do not cast it with `as`, and do not add a second schema library.
- Tests pass typed fakes in; do not use `vi.mock`.
- Commit messages say why. Do not push or rewrite history without approval.

## Tool choices

Each was tried against the planted defects. Do not change one without a new trial.

- Keep ESLint with typescript-eslint; do not move to oxlint. oxlint matches the fixtures only through its alpha JS
  plugin interface, it obeys `oxlint-disable` comments (a new bypass), and the eslint-comments plugin crashes under it.
  It saves about 1.4 s. Revisit when oxlint JS plugins are stable.
- Keep Vitest 4.1. StrykerJS vitest-runner 10 builds test filters that Vitest 5 does not match, so every mutant
  runs no test and survives with exit code 0. `test/gates/mutation.test.ts` fails if this comes back.
- Keep Fallow for CRAP and duplication; do not add crap-score. crap-score exits 0 at CRAP 72 and cannot scope to
  changed code. Fallow's dead-code and architecture checks stay off: knip and dependency-cruiser find more.
  Fallow's 0.1% duplication limit is a share of the whole project; lower it when the code passes about 60k lines.
- Do not add type-coverage. ESLint already fails `as any`, and its strict mode fails library defaults.
- Do not format Markdown with Biome. Its formatter removes the blank line before a list, which markdownlint requires.
- Keep `exactOptionalPropertyTypes`. It goes beyond Pocock's recommended flags; it found real defects in another project.
