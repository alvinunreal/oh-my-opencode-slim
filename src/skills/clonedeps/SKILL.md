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

### Step 1: Check Existing State

First check whether `.slim/clonedeps.json` exists.

If it exists:

1. Read it before asking librarian for a new plan.
2. Check whether each listed `path` exists under `.slim/clonedeps/repos/`.
3. Reuse existing cloned repos when they already satisfy the user's task.
4. Only ask librarian for new recommendations if the existing manifest is
   missing, stale, or insufficient for the current task.

Do not rescan/re-plan from scratch when the manifest already has useful entries.

### Step 2: Ask Librarian for the Clone Plan

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

### Step 3: Verify and Confirm the Plan

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

### Step 4: Clone Sources Manually

Create one folder per source repository under:

```text
.slim/clonedeps/repos/<safe-repo-name>/
```

Derive the safe name from the repository owner/name, not from the package name.
For example, `https://github.com/opencode-ai/opencode.git` becomes
`opencode-ai__opencode`. Replace `/` with `__`, strip common `.git` suffixes,
and replace other unsafe path characters with `_`.

If multiple packages come from the same monorepo, clone the repository once and
point each manifest entry at the same repo path with different `packagePath`
values as needed. Do not create ecosystem folders, per-package clone folders, or
per-version folders. If two different source repositories normalize to the same
safe name, disambiguate manually and record the chosen path in
`.slim/clonedeps.json`.

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

### Step 5: Write Local State

Write `.slim/clonedeps.json` so future agents know what exists:

```json
{
  "version": "1.0.0",
  "updatedAt": "2026-05-12T00:00:00.000Z",
  "dependencies": [
    {
      "name": "@opencode-ai/plugin",
      "resolvedVersion": "1.3.17",
      "repoUrl": "https://github.com/opencode-ai/opencode.git",
      "ref": "v1.3.17",
      "path": ".slim/clonedeps/repos/opencode-ai__opencode",
      "packagePath": "packages/plugin",
      "reason": "Plugin API source used by the project"
    },
    {
      "name": "@opencode-ai/sdk",
      "resolvedVersion": "1.3.17",
      "repoUrl": "https://github.com/opencode-ai/opencode.git",
      "ref": "v1.3.17",
      "path": ".slim/clonedeps/repos/opencode-ai__opencode",
      "packagePath": "packages/sdk/js",
      "reason": "Core SDK source used to inspect runtime behavior"
    }
  ]
}
```

If a clone fails after earlier clones succeeded, still write state for the
successful clones so future inspection is not misleading.

Do not add `.slim/clonedeps.json` to `.gitignore`. It is small, reviewable
project metadata that can be committed. Only the cloned repository contents
under `.slim/clonedeps/repos/` should be ignored.

### Step 6: Update Ignore Files

Update `.gitignore` with an idempotent marker block:

```gitignore
# BEGIN oh-my-opencode-slim clonedeps
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

### Step 7: Register Dependency Source in AGENTS.md

After successful cloning, update the repository root `AGENTS.md` so future
agents know why the dependency source exists and where to look.

If `AGENTS.md` already has a `## Cloned Dependency Source` section, update that
section. Otherwise append this section:

Use this format and list the actual repos directly. Keep each item to one short
sentence so future agents do not need an extra read just to know what is there:

```markdown
## Cloned Dependency Source

Read-only dependency source repositories are available under
`.slim/clonedeps/repos/` for inspection. Do not edit these clones.

- `.slim/clonedeps/repos/<safe-name>/` - `<repo>` at `<ref>`; <one sentence on
  why this source is useful>.
- `.slim/clonedeps/repos/<safe-name-2>/` - `<repo>` at `<ref>`; <one sentence on
  why this source is useful>.
```

Also keep `.slim/clonedeps.json` updated as the structured manifest, but do not
make agents read it for the basic repo list.

## Cleanup

When the user asks to clean cloned dependencies, remove:

- `.slim/clonedeps/repos/`
- the managed clonedeps marker blocks from `.gitignore` and `.ignore`

Ask before removing `.slim/clonedeps.json` or the `AGENTS.md` section because
they may be intentional project metadata.
