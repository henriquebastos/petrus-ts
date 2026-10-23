# Agent instructions

Read `README.md` and `docs/style-guide.md` before you change code. Read the record in `docs/decisions/`
that covers the area you change.

## Done means green

- Run `pnpm feedback` before you say a change is done. Report the result.
- A behaviour change comes with a test that fails without it. Prefer a fast-check property when a rule holds for all inputs.
- Run `pnpm format` to format. Do not format by hand.

## Rules that are easy to break

- `fixtures/` holds planted defects. Each file must keep failing its gate. Do not fix, format or lint-clean it.
  When you change a gate config, update the fixture and its expected output in the same change.
- `packages/net` stays pure: no Node builtins, no npm packages, no time, no randomness.
- Code in `packages/*/src` gets time, timers and randomness from injected seams, never from `Date`, `setTimeout` or `Math.random`.
- Import another package only through its root (`@petrus/net`), and only from a lower layer.
- Every `eslint-disable` and `@ts-expect-error` has a reason on the same line, after `--`.
- Parse untrusted input with a Zod schema. Do not cast it with `as`.
- Tests pass typed fakes in; do not use `vi.mock`.

## Records

- There is no Ariad, roadmap or worklog here. Record a decision in `docs/decisions/` when it is hard to reverse or easy to forget.
- The design reference is the Obsidian conduit "2026-10-21 Petrus Next" (`/Users/henrique/me/vault/Conduits/2026-10-21 Petrus Next/`).
- Commit messages say why. Do not push or rewrite history without approval.
