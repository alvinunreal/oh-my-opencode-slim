# Worktrees

`worktrees` is a bundled Orchestrator skill that manages Git worktrees as safe,
isolated coding lanes under `.slim/worktrees/<slug>/`. It lets agents work on
parallel, complex, or high-risk tasks in separate checkouts without polluting
your current workspace.

The skill does not exist to explain Git worktrees. It gives OMO an opinionated
safety protocol for planning lanes, assigning agents, validating diffs,
integrating changes, and cleaning up without losing user work.

---

## What It Does

When managing worktree coding lanes, the Orchestrator:

1. **Checks workspace state:** confirms the repo, branch, dirty state, and
   existing `git worktree list` output.
2. **Registers metadata:** maintains `.slim/worktrees.json` to track active
   lanes, branches, base refs, purposes, owners, areas, and statuses.
3. **Applies confirmation gates:** asks before creating/removing worktrees,
   creating/deleting branches, merging, rebasing, cherry-picking, pruning, or
   running destructive commands.
4. **Validates and integrates:** runs relevant checks inside the lane, presents a
   diff against the base branch, and asks before integrating.
5. **Gates cleanup:** refuses to remove dirty worktrees or delete unmerged
   branches without explicit approval.

---

## How To Use It

Ask the Orchestrator directly to isolate a complex or parallel task:

```text
Create a worktree lane to refactor the auth logic.
```

Or for risky operations:

```text
Let's use an isolated worktree to test upgrading the database packages.
```

The Orchestrator will analyze the work, present a lane plan (with slug, path, base branch, and purpose), and ask for your permission before initializing the worktree.

---

## Files It Creates

### `.slim/worktrees/<slug>/`

Local Git worktrees are placed here, separated from your main checkout while
sharing the same underlying Git database. Specialists such as `@fixer` or
`@designer` are directed to write and run tests strictly within this path.

For example, `.slim/worktrees/refactor-auth/` contains a copy of the repository files on the `omo/refactor-auth` branch.

### `.slim/worktrees.json`

A local metadata registry mapping active worktree lanes.

```json
{
  "version": "1.0.0",
  "updatedAt": "2026-06-14T00:00:00.000Z",
  "lanes": [
    {
      "slug": "refactor-auth",
      "branch": "omo/refactor-auth",
      "path": ".slim/worktrees/refactor-auth",
      "base": "main",
      "purpose": "Refactor token parsing module",
      "owner": "orchestrator",
      "status": "active",
      "areas": ["src/auth"],
      "createdAt": "2026-06-14T12:00:00.000Z"
    }
  ]
}
```

---

## Safety Guidelines

- **Orchestrator control:** The orchestrator owns worktree coordination.
  Specialists can work inside lanes but should not run lane-management Git
  commands unless explicitly instructed.
- **Strict Confirmations:** No git mutating commands (e.g. `worktree add`, `worktree remove`, `branch`, `merge`, `rebase`, `cherry-pick`, `prune`) are run without manual prompt agreement.
- **No force operations:** Destructive git operations such as `reset --hard`,
  `clean`, force-push, or branch deletion must not be executed automatically.
- **Git exclusions:** `.slim/worktrees/` is git-ignored. `.ignore` is updated so
  OpenCode can still read lane contents. `.slim/worktrees.json` is git-ignored
  by default because it is local workflow metadata.

Managed `.gitignore` block:

```gitignore
# BEGIN oh-my-opencode-slim worktrees
.slim/worktrees/
.slim/worktrees.json
# END oh-my-opencode-slim worktrees
```

Managed `.ignore` block:

```ignore
# BEGIN oh-my-opencode-slim worktrees
!.slim/
!.slim/worktrees.json
!.slim/worktrees/
!.slim/worktrees/**
# END oh-my-opencode-slim worktrees
```

---

## When To Use It

- **Risky implementation tasks:** major package upgrades, core architectural
  migrations, or database schema changes.
- **Parallel task coordination:** separate lanes for independent background
  agents or an urgent hotfix while another feature is unfinished.
- **Complex agent delegation:** another agent can implement in a clean checkout
  while the main workspace remains untouched.

## When NOT To Use It

- **Trivial modifications:** single-file tweaks, documentation updates, or tiny
  fixes.
- **Non-Git repositories:** projects that do not use Git.
- **Disk/resource constraints:** large projects in environments with very limited
  disk space.
