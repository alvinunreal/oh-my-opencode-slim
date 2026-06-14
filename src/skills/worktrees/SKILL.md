---
name: worktrees
description: Manage Git worktrees as OMO safe isolated coding lanes for complex, risky, or parallel work.
---

# Worktrees Orchestration Protocol

The `worktrees` skill provides an opinionated, safe orchestration protocol for
managing Git worktrees as isolated coding lanes. Its value is giving the Orchestrator a consistent OMO workflow for parallel agents, risky experiments, integration review, and cleanup.

## Core Contract

This is an **orchestrator-only** workflow. Other specialists such as `@fixer`
or `@designer` can be assigned tasks inside a worktree lane, but the
Orchestrator owns lane planning, branch/path selection, file ownership,
delegation, diff validation, integration, and cleanup.

All worktrees reside under the default path:

```text
.slim/worktrees/<slug>/
```

Do not create worktrees as sibling directories of the main repository.

### State Tracking (`.slim/worktrees.json`)

Use the optional local metadata manifest `.slim/worktrees.json` to maintain
structural tracking:

```json
{
  "version": "1.0.0",
  "updatedAt": "2026-06-14T00:00:00.000Z",
  "lanes": [
    {
      "slug": "feature-auth-v2",
      "branch": "omos/feature-auth-v2",
      "path": ".slim/worktrees/feature-auth-v2",
      "base": "main",
      "purpose": "refactor authentication flow to use OAuth2",
      "owner": "orchestrator",
      "status": "active",
      "areas": ["src/auth", "src/config"],
      "createdAt": "2026-06-14T12:00:00.000Z"
    }
  ]
}
```

If `.slim/worktrees.json` does not exist, create it when initializing a lane,
and keep it updated as lanes are transitioned, integrated, or pruned. Treat it
as local workflow metadata by default; ask before making it part of a committed
project convention.

---

## Safety Guidelines

Before executing any Git mutation command, the Orchestrator must observe the
following guards:

### 1. Pre-Flight Checklist
- Confirm the current directory is inside a Git repository.
- Check the current branch, base branch, and dirty/uncommitted state.
- Inspect the output of `git worktree list` to avoid path or branch conflicts.
- Ensure the branch name (e.g. `omos/<slug>` or custom project convention) does not already exist locally or on remote.
- Ensure `.slim/worktrees/` is ignored by Git before creating nested worktrees.

### 2. Mandatory User Confirmation
You must seek explicit user confirmation before executing:
- `git worktree add` or `git worktree remove`
- Branch creation, deletion, or renaming
- Merges, rebases, or cherry-picks
- `git prune` or `git worktree prune`
- Destructive commands (e.g., `git reset --hard`, `git clean`, `git push --force`, or removing a dirty worktree directory).

Never execute destructive commands, delete branches, remove dirty worktrees, or
clean uncommitted changes without explicit user confirmation for that exact
operation.

### 3. Ignore File Setup

Before creating lanes, add or update managed marker blocks only.

`.gitignore`:

```gitignore
# BEGIN oh-my-opencode-slim worktrees
.slim/worktrees/
.slim/worktrees.json
# END oh-my-opencode-slim worktrees
```

`.ignore`:

```ignore
# BEGIN oh-my-opencode-slim worktrees
!.slim/
!.slim/worktrees.json
!.slim/worktrees/
!.slim/worktrees/**
# END oh-my-opencode-slim worktrees
```

---

## Workflow Guide

### Phase 1: Planning & Setup
1. Identify the task scope and determine a short `<slug>` for the worktree.
2. Formulate a branch name. Default to `omos/<slug>` unless project/user conventions dictate otherwise.
3. Validate repository safety. Ask the user for confirmation to initialize the lane.
4. Ensure the managed ignore blocks are present.
5. Run:
   ```bash
   git worktree add -b <branch-name> .slim/worktrees/<slug> <base-commit/branch>
   ```
6. Register the metadata in `.slim/worktrees.json`.

### Phase 2: Execution & Delegation
1. Run all sub-agents with their working directory set strictly to the worktree
   path, such as `.slim/worktrees/<slug>`.
2. Do not modify the main checkout for lane work. Keep build, test, and edit
   operations isolated inside the lane.
3. Track file or folder ownership per lane to avoid merge conflicts between
   parallel agents.
4. Commit progress within the worktree only when the user asked for commits or
   approved local checkpoint commits.

### Phase 3: Integration & Validation
Before merging or integrating the worktree branch:
1. Run lint, build, formatting, and unit tests inside the worktree directory.
2. Generate and display a clear diff comparing the worktree branch to the
   integration base branch.
3. Ask the user for confirmation to integrate.
4. Perform the approved integration, such as merge or cherry-pick, from the main
   checkout or the user-approved integration checkout.

### Phase 4: Cleanup & Pruning
1. Ensure all changes are safely merged or archived.
2. Confirm the worktree has no uncommitted changes.
3. Request user approval to remove the worktree.
4. Safely remove the worktree using:
   ```bash
   git worktree remove .slim/worktrees/<slug>
   ```
5. Update `.slim/worktrees.json` to mark the lane as `archived` or remove it.

---

## When to Use vs. Not Use

### Use When:
- Performing risky or destructive refactoring that could break the active working environment.
- Working on parallel tasks/bugfixes that require switching contexts without committing half-finished work.
- Running independent background agents on separate branches.
- Conducting exploratory spikes or prototyping that may be discarded.
- Isolating third-party packages or complex upgrades.
- Explicitly asked to use worktrees for a specific task.

### Do NOT Use When:
- Making simple single-file changes, documentation updates, or minor bug fixes.
- Working in a git repository that is not fully initialized or has complex multi-submodule states not supported easily by worktrees.
