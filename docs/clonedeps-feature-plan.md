# Clonedeps Skill Feature Plan

## Goal

Add a bundled `clonedeps` skill that helps the orchestrator make important
dependency source code locally available to OpenCode. The skill should identify a
small number of core dependencies worth cloning, resolve official repositories
and refs, clone them into an ignored workspace, and add enough local context for
future agents to find and use those clones.

## Core Design Decision

`clonedeps` is a workflow skill, not a helper-script feature.

The orchestrator and `@librarian` do the repo-specific thinking:

- inspect the project in whatever languages/ecosystems it uses;
- identify dependencies where local source materially helps;
- resolve official source repositories and tags/commits;
- handle ecosystem-specific version/tag weirdness manually.

The orchestrator performs approved git/filesystem operations directly. There is
no `clonedeps.mjs`, no universal dependency scanner, and no script-owned schema
that tries to model every package ecosystem.

## Non-Goals

- Do not clone every dependency.
- Do not auto-run for every project on startup.
- Do not make cloned dependency source part of git history.
- Do not run install/build/test scripts inside cloned dependencies.
- Do not replace `@librarian` for ordinary docs/API lookup.
- Do not maintain a cross-language dependency parser in this repository.

## Workflow

1. Orchestrator loads `clonedeps`.
2. Orchestrator asks `@librarian` to inspect the repo and produce a small clone
   plan across whatever languages/ecosystems are present.
3. Librarian returns dependency name, version/range if discoverable, official
   repo URL, ref/tag/commit, package subdirectory if monorepo, reason, and
   caveats.
4. Orchestrator verifies refs where practical with `git ls-remote` and asks
   librarian to resolve missing or module-specific tags.
5. Orchestrator presents the plan and asks for user approval unless the user
   explicitly requested immediate cloning.
6. Orchestrator clones/fetches each approved repo into
   `.slim/clonedeps/repos/<safe-name>/`.
7. Orchestrator writes `.slim/clonedeps.json` with local paths, refs, and reasons.
8. Orchestrator updates `.gitignore`, `.ignore`, and root `AGENTS.md`.

## Repository Layout

Use one folder per dependency. Do not create ecosystem folders or per-version
folders.

```text
.slim/
  clonedeps.json
  clonedeps/
    repos/
      @scope__pkg/
      package/
```

Example state:

```json
{
  "version": "1.0.0",
  "updatedAt": "2026-05-12T00:00:00.000Z",
  "dependencies": [
    {
      "name": "@opencode-ai/sdk",
      "resolvedVersion": "1.3.17",
      "repoUrl": "https://github.com/example/repo.git",
      "ref": "v1.3.17",
      "path": ".slim/clonedeps/repos/@opencode-ai__sdk",
      "packagePath": "packages/sdk/js",
      "reason": "Core OpenCode session/runtime integration"
    }
  ]
}
```

## Ignore File Management

The orchestrator should update ignore files using idempotent marker blocks.

`.gitignore`:

```gitignore
# BEGIN oh-my-opencode-slim clonedeps
.slim/clonedeps.json
.slim/clonedeps/repos/
# END oh-my-opencode-slim clonedeps
```

`.ignore`:

```ignore
# BEGIN oh-my-opencode-slim clonedeps
!.slim/
!.slim/clonedeps.json
!.slim/clonedeps/
!.slim/clonedeps/repos/
!.slim/clonedeps/repos/**
.slim/clonedeps/repos/**/.git/
.slim/clonedeps/repos/**/.git/**
# END oh-my-opencode-slim clonedeps
```

OpenCode currently reads `.gitignore` then `.ignore` with the `ignore` package,
so later negated `.ignore` patterns can make the cloned tree visible to OpenCode
while git still ignores it.

## AGENTS.md Registration

After successful cloning, append or update root `AGENTS.md`:

```markdown
## Cloned Dependency Source

Selected dependency source repositories are available under
`.slim/clonedeps/repos/` for local inspection. These clones are ignored by git
but intentionally unignored for OpenCode visibility. They are local cache and
may not exist in every checkout.

If `.slim/clonedeps.json` exists, read it before using the clones; it records
package names, versions/refs, local paths, and why each dependency was cloned.

Use these clones for dependency internals/source inspection. For ordinary API
usage or current docs, prefer `@librarian`.
```

## Safety Constraints

- Ask for approval before network cloning unless user explicitly says to clone.
- Limit default plan to 3-5 repos.
- Prefer pinned tags/commits.
- Verify existing clone origin before fetching into it.
- Warn when repo is a very large monorepo.
- Never run package scripts from cloned repositories.
- Do not clone private/auth-required repositories without explicit user action.
- Do not overwrite user-authored ignore or AGENTS content outside managed
  sections.
- If a clone fails after earlier clones succeeded, still write state for the
  successful clones.

## Repository Integration

- `src/skills/clonedeps/**` — bundled skill payload.
- `src/cli/custom-skills.ts` — `allowedAgents: ['orchestrator']`.
- `scripts/verify-release-artifact.ts` — ensure `clonedeps/SKILL.md` is present.
- `README.md`, `docs/skills.md`, and codemaps document the skill.
