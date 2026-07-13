# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the project's domain glossary and architecture narrative.
- **`docs/adr/`** at the repo root — read ADRs that touch the area you're about to work in.
- **`codemap.md`** at the repo root — the repo's own architecture map (referenced by `AGENTS.md`); read it for module responsibilities and integration points before deep work in a folder.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture` — external skills, not bundled in this repo) creates them lazily when terms or decisions actually get resolved.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Triage and labels

Operational triage roles and their repo labels are documented in
`docs/agents/triage-labels.md` (source of truth) and `docs/maintainers.md`.
The external-PR triage policy lives in `docs/agents/issue-tracker.md`.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-001 (session reflection mode) — but worth reopening because…_
