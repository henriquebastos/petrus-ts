# 0003 Lint rules beyond the shared configs

- Status: accepted, 2026-10-23
- Decided by: Henrique asked for the gaps to be closed "the way Matt Pocock would do"; the Driver chose each rule from Pocock's own sources.

## Context

The base lint config is typescript-eslint `strictTypeChecked` plus `stylisticTypeChecked`.
Running bad examples through that config found 16 bugs that pass it
(conduit `03-expand/foundations/explained/index.md`, section 1e).
Pocock's positions, with sources and grades, are in `03-expand/foundations/pocock-positions.md` in the conduit.
His rule files (`default-exports`, `import-type`, `interface-extends`, `throwing`, `return-types`) are the most direct evidence.

## Decision

Each row is enforced in `eslint.config.js`, `tsconfig.base.json` or `.dependency-cruiser.cjs`, and has a planted defect in `fixtures/`.

| Gap                                                                | Decision                                                                                                    | Pocock basis                                                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `if (timeoutMs)` is false for `0`                                  | `strict-boolean-expressions` for numbers only. Strings and objects may be tested for truth.                 | His book writes `if (username)`; he has no position on the rule. Numbers are where the bug is: a count or a timeout of `0`. |
| A `switch` can miss a case                                         | `switch-exhaustiveness-check`. In a `default`, write `value satisfies never`.                               | "'satisfies never' is SO GOOD for exhaustiveness checking."                                                                 |
| `JSON.parse(body) as T` and `as unknown as T` pass                 | `no-unsafe-type-assertion`. Parse untrusted input with a schema (Zod).                                      | "`as` lets you lie to TypeScript"; use Zod for input you do not control.                                                    |
| `{ ... } as Arc` with a missing field passes                       | `consistent-type-assertions` with `objectLiteralTypeAssertions: "never"`. Use an annotation or `satisfies`. | `as` as the default annotation is "almost certainly wrong".                                                                 |
| Empty `catch {}` and a lost `cause` pass                           | `@eslint/js` recommended (`no-empty`, `preserve-caught-error`).                                             | No Pocock source. typescript-eslint's own setup includes this config.                                                       |
| `import { type X }` still loads the module                         | `no-import-type-side-effects`, and a ban on inline `type` specifiers in imports.                            | Rule file `import-type`: prefer top-level `import type`.                                                                    |
| Default exports pass                                               | Banned, except in tool config files that require one.                                                       | Rule file `default-exports`, including its framework exception.                                                             |
| `import "./x.js"` passes and fails in Node                         | `no-restricted-imports` for relative `.js` paths.                                                           | No Pocock source. Node runs the `.ts` source here.                                                                          |
| `Date.now()` in `net` passes                                       | `no-restricted-properties`, `-globals`, `-syntax` for time, timers and `Math.random` in `packages/*/src`.   | No Pocock source. Project rule: the runtime takes time from an injected clock.                                              |
| depcruise missed `exports` and type-only cycles                    | `enhancedResolveOptions.exportsFields` and `tsPreCompilationDeps: true`.                                    | Tool setting.                                                                                                               |
| knip cannot see an unused export behind `export *`                 | `export *` is banned; re-export names one by one.                                                           | No Pocock source.                                                                                                           |
| ESLint rejects `_unused` arguments that tsc accepts                | `argsIgnorePattern: "^_"`, `varsIgnorePattern: "^_"`.                                                       | Tool setting.                                                                                                               |
| `consistent-type-definitions: type` also flags `interface extends` | Rule off. A syntax rule bans an `interface` without `extends`.                                              | "`type` by default"; rule file `interface-extends`: interfaces for inheritance.                                             |
| The planted `as any` defect was too easy                           | The fixtures also plant `as T` and `as unknown as T`.                                                       | Same as the `as` row.                                                                                                       |
| `no-await-in-loop` flags correct sequential code                   | Not enabled.                                                                                                | Tool behaviour.                                                                                                             |
| `noPropertyAccessFromIndexSignature`                               | Not enabled.                                                                                                | His book: "no stricter than strict and noUncheckedIndexedAccess".                                                           |

Other rules added for the house rules: `explicit-function-return-type` for module functions (rule file `return-types`),
`consistent-type-imports` and `consistent-type-exports`, `eslint-comments/require-description` for every suppression,
`complexity` 10 and `max-depth` 4.

## Consequences

- Pocock's book keeps only `strict` and `noUncheckedIndexedAccess`. This repository also keeps `exactOptionalPropertyTypes`,
  which the accepted proposal chose because it found 8 real defects in another project. This is a known difference from Pocock.
- A brand constructor (`placeId`) needs an `as` with a reasoned suppression. It is the only accepted kind of unsafe assertion.
- Input from outside the process is parsed with Zod. The gate tests already do this for tool output.
