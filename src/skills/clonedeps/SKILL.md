---
name: clonedeps
description: Clone important project dependency source code into an ignored local workspace so OpenCode can inspect library internals. Use when the user asks to clone dependencies, inspect dependency/source internals, understand SDK/framework behavior from source, debug library implementation details, or make core dependency repos locally readable. Do not use for ordinary API/docs questions where @librarian is enough.
---

# Clonedeps Skill

You help users make a small set of important dependency source repositories
locally readable to OpenCode.

This is a workflow skill, not a command wrapper. Do not use a helper script for
dependency detection, ref validation, cloning, status, or cleanup. The
orchestrator and `@librarian` do the repo-specific thinking; the orchestrator
performs the approved filesystem/git operations directly.

## Workflow

### Step 1: Ask Librarian for the Clone Plan

Delegate dependency discovery and source resolution to `@librarian`.

Use this prompt:

```md
Understand this project first, then recommend remote source repos that would
help a developer work on it.

Read enough of the current repo to understand:
- what the project does
- its main architecture
- the important integration points
- what external systems or libraries it depends on in practice

Think like a developer trying to debug or extend this project.

Which remote repositories, if cloned locally, would actually help understand the
codebase or solve likely implementation/debugging tasks?

Do not make a dependency dump. Most dependencies are not worth cloning.
Recommend a repo only when its source code would be more useful than docs or the
current repo alone.

For each recommendation, include:
- repo name
- repo URL
- suggested ref/tag/commit if known
- why cloning this source would help
- when it would be useful
- caveats

Also include:
- current-repo files/folders to inspect first
- repos/dependencies you considered but would not clone

Keep it small. Prefer 0–3 strong recommendations over 5 weak ones. If nothing
clearly needs cloning, say so.
```

Librarian should return a small plan with:

- dependency name;
- current version/range if discoverable;
- official source repository URL;
- tag/commit/ref to check out;
- package subdirectory if the source is a monorepo;
- reason local source helps;
- caveats such as huge repo, missing tag, or uncertain version mapping.

Prefer at most 3-5 core dependencies. Include user-mentioned dependencies and
central frameworks, SDKs, ORMs, runtime/plugin APIs, or build/runtime tools. Do
not clone tiny utilities, transitive dependencies, or dev-only tools unless they
are directly relevant to the active task.

### Step 2: Verify and Confirm the Plan

The orchestrator owns final approval. Before cloning:

1. Verify refs manually where possible with `git ls-remote`.
2. Prefer pinned tags or commit SHAs. If no exact tag exists, ask librarian to
   find the correct module-specific tag/commit or explain the fallback.
3. Only use HTTPS GitHub/GitLab-style repository URLs by default. Reject
   `file://`, SSH URLs, local paths, URLs with embedded credentials, and private
   or auth-required repositories unless the user explicitly approves that case.
4. Present the plan to the user with dependency, repo URL, ref, reason, and
   caveats.
5. Ask for confirmation before network cloning unless the user explicitly asked
   to clone immediately.

### Step 3: Clone Sources Manually

Create one folder per dependency under:

```text
.slim/clonedeps/repos/<safe-dependency-name>/
```

Use a safe name by replacing `/` with `__` and other unsafe path characters with
`_`. Do not create ecosystem folders or per-version folders. If two dependencies
normalize to the same safe name, disambiguate manually and record the chosen path
in `.slim/clonedeps.json`.

Clone/fetch with normal git commands. For an existing clone, first verify that
`git remote get-url origin` matches the approved repo URL. If it does not match,
stop and ask whether to clean/reclone.

Safe manual git pattern:

1. `git ls-remote <repoUrl> <ref>` to verify the ref where practical.
2. Clone without submodules/recursive behavior.
3. Prefer shallow fetch/clone where practical.
4. Clone into a temporary directory under `.slim/clonedeps/repos/`, then move it
   into the final safe-name path after checkout succeeds.
5. Remove failed temporary clones.

Do not run dependency install/build/test scripts from cloned repositories.

### Step 4: Write Local State

Write `.slim/clonedeps.json` so future agents know what exists:

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
      "reason": "Core runtime SDK used by the project"
    }
  ]
}
```

If a clone fails after earlier clones succeeded, still write state for the
successful clones so future inspection is not misleading.

### Step 5: Update Ignore Files

Update `.gitignore` with an idempotent marker block:

```gitignore
# BEGIN oh-my-opencode-slim clonedeps
.slim/clonedeps.json
.slim/clonedeps/repos/
# END oh-my-opencode-slim clonedeps
```

Update `.ignore` so OpenCode can read the cloned source while git still ignores
it:

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

Only edit content inside these marker blocks.

### Step 6: Register Dependency Source in AGENTS.md

After successful cloning, update the repository root `AGENTS.md` so future
agents know why the dependency source exists and where to look.

If `AGENTS.md` already has a `## Cloned Dependency Source` section, update that
section. Otherwise append this section:

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

Keep the section concise. Do not paste the full clone plan into `AGENTS.md`;
the detailed source of truth is `.slim/clonedeps.json`.

## Cleanup

When the user asks to clean cloned dependencies, remove:

- `.slim/clonedeps/repos/`
- `.slim/clonedeps.json`
- the managed clonedeps marker blocks from `.gitignore` and `.ignore`

Ask before removing the `AGENTS.md` section unless the user explicitly requests
full cleanup.
