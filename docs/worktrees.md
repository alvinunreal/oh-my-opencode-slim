# Worktrees

`worktrees` is a bundled Orchestrator skill that manages Git worktrees as
isolated coding lanes under `.slim/worktrees/<slug>/`, so agents can work on
parallel, complex, or high-risk tasks without polluting your checkout. It is
not a Git tutorial: it is the safety protocol for planning lanes, assigning
agents, validating diffs, integrating, and cleaning up without losing work.

---

## Usage

```text
Create a worktree lane to refactor the auth logic.
```

```text
Let's use an isolated worktree to test upgrading the database packages.
```

The Orchestrator checks workspace state, proposes a lane plan (slug, path, base
branch, purpose), and asks before creating the worktree, branch, or any
mutating Git command.

---

## Files It Creates

### `.slim/worktrees/<slug>/`

Local worktrees sharing the repository's Git database. Specialists such as
`@fixer` or `@designer` write and run tests strictly inside the lane; for
example, `.slim/worktrees/refactor-auth/` holds the files for the
`omos/refactor-auth` branch.

### `.slim/worktrees.json`

Local lane registry (git-ignored), e.g.:

```json
{
  "version": "1.0.0",
  "updatedAt": "2026-06-14T00:00:00.000Z",
  "lanes": [
    {
      "slug": "refactor-auth",
      "branch": "omos/refactor-auth",
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

## Safety

- The Orchestrator owns lane coordination; specialists do not run
  lane-management Git commands unless instructed.
- No mutating Git command (`worktree add|remove`, `branch`, `merge`, `rebase`,
  `cherry-pick`, `prune`) runs without confirmation, and destructive operations
  (`reset --hard`, `clean`, force-push, branch deletion) are never automatic.
- Cleanup refuses dirty worktrees and unmerged branches without explicit
  approval.
- `.slim/worktrees/` and `.slim/worktrees.json` are git-ignored via a managed
  `.gitignore` block; the skill writes no `.ignore` allowlist and only edits its
  own marker blocks.

## When To Use It

Risky implementations (package upgrades, architectural migrations, schema
changes), parallel lanes for independent agents, or a hotfix while another
feature is unfinished.

## When NOT To Use It

- Trivial modifications: single-file tweaks, documentation updates, tiny fixes.
- Non-Git repositories.
- Environments with very limited disk space.
