# src/skills/clonedeps/

## Responsibility

Workflow-only bundled OpenCode skill for local dependency source mirroring. It
instructs the orchestrator to use `@librarian` for dependency discovery and
source URL/ref resolution, then perform approved git/filesystem operations
directly.

## Design

- `SKILL.md` is the prompt contract loaded by OpenCode and assigned only to the
  orchestrator.
- No helper script is bundled. The skill avoids brittle cross-ecosystem parsing
  and keeps repo-specific judgment in librarian/orchestrator.
- State is trackable project metadata stored in `.slim/clonedeps.json`; clone
  contents live under `.slim/clonedeps/repos/<safe-dependency-name>/` and are
  ignored by git.
- The workflow updates `.gitignore`, `.ignore`, and root `AGENTS.md` with
  concise marker sections so cloned source stays out of git but visible to
  OpenCode and discoverable by future agents.

## Flow

1. Orchestrator checks `.slim/clonedeps.json` first and reuses existing clones
   when they satisfy the current task.
2. Orchestrator asks librarian for a small source-resolution plan across the
   repository's actual languages/ecosystems.
3. Orchestrator verifies refs where possible and asks the user to approve.
4. Orchestrator clones/fetches each approved source repo once into
   `.slim/clonedeps/repos/<safe-repo-name>/`.
5. Orchestrator writes `.slim/clonedeps.json` with paths, refs, and reasons.
6. Orchestrator updates `.gitignore`, `.ignore`, and root `AGENTS.md`; the
   AGENTS section lists each read-only clone path directly with a one-sentence
   purpose.

## Integration

- Registered in `src/cli/custom-skills.ts` with orchestrator-only permission.
- Included in release verification via `scripts/verify-release-artifact.ts`.
- Documented in `docs/skills.md` and included in `src/skills/codemap.md`.
