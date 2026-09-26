# src/skills/simplify/

## Responsibility

- Provide a behavior-preserving refactoring skill contract that constrains code cleanup to clarity-focused,
  low-risk changes.
- Define explicit quality gates (understand-before-edit, behavior parity, incremental simplification, rollback-friendly diffs)
  for any simplification task.
- Ship only metadata; no local runtime state machine is kept in this directory.

## Design

- Contract layer: `SKILL.md` is the executable prompt specification with explicit phases:
  - pre-change understanding
  - simplification candidate selection
  - incremental transformation and verification
  - final review checklist.
- Documentation layer: `README.md` explains intent, source provenance, and plugin install behavior.
- Policy model is declarative (`description`, allowed usage, checklist) consumed by the OpenCode skill executor,
  without helper scripts or plugin code dependencies.

## Flow

- Agent discovery resolves `src/skills/simplify` as a custom skill entrypoint, then reads `SKILL.md` at runtime.
- Runtime behavior is gated by `src/cli/custom-skills.ts` (`allowedAgents: ['oracle']`) and by skill permissions
  computed in `getSkillPermissionsForAgent()`.
- In practice the workflow is read-only and context-driven: simplify instructions require understanding of callers,
  edge cases, and tests before mutation, then apply local, scoped refactors with validation.
- Consumers (Fixer/Oracle/Reviewer tasks) rely on this contract as operational constraints, not as executable TypeScript.

## Integration

- Installed by plugin installer (`installCustomSkills`) using `src/cli/install.ts` via `installCustomSkill()`.
- Skill visibility is handled by native v1/v2 host discovery from finalized agent/session permissions; hidden skills are denied and discoverable skills require permission approval. The plugin does not rewrite `<available_skills>` in conversation text.
- Release integrity: `scripts/verify-release-artifact.ts` checks for `src/skills/simplify/SKILL.md` in package tarballs.
- Operationally paired with codemap/fixer flows in `src/index.ts` orchestrations for post-feature readability hardening.
