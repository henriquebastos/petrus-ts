# 0001 Project structure and records

- Status: accepted, 2026-10-23
- Decided by: Henrique

## Context

Petrus TS is a new project. The Python Petrus is a separate reference implementation; nothing is ported by default.
The design was made before this repository existed, in the Obsidian conduit "2026-10-21 Petrus Next"
(`/Users/henrique/me/vault/Conduits/2026-10-21 Petrus Next/`). The Python Petrus uses the Ariad method.

## Decision

- Do not use Ariad in this repository.
- The conduit stays the design reference: the dossier (`02-collapse/dossier.md`) for the runtime design,
  and `03-expand/foundations/` for the toolchain and the style rules with examples.
- This repository keeps only what the code needs to be understood and changed:
  - `README.md`: what the project is and how to run it;
  - `AGENTS.md`: instructions for coding agents;
  - `docs/style-guide.md`: the house rules, with examples from this code;
  - `docs/decisions/`: one short record for each decision that is hard to reverse or easy to forget.
- Add a document under `docs/` only when the code or a decision needs it.

## Consequences

- There is no roadmap, worklog or debt ledger in the repository. Git history and the decision records carry the reasons.
- A reader without the vault can still build, test and change the code. Links to the conduit are background, not instructions.
