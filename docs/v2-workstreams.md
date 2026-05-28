# Internal: V2 Workstreams Archive

> **Internal historical planning doc.** This file tracked V2 feature branches
> and beta integration while background orchestration was being built. It is not
> current user-facing install or release guidance. For the default release, see
> [Installation](installation.md) and
> [Background Orchestration](v2-background-orchestration.md).

This archive tracked focused V2 branches and local worktrees while background
orchestration was being built. It is not current release guidance.

| Branch | Worktree | Purpose | Status | Notes |
|---|---|---|---|---|
| `v2-beta` | repo root | V2 integration/release | Historical | Former source of truth for combined V2 pre-release validation. |
| `v2/misc` | `.slim/worktrees/v2-misc` | Misc V2 cleanup | Merged | Removed custom subtask feature; can continue misc follow-ups here if desired. |
| `v2/tui` | `.slim/worktrees/v2-tui` | TUI integration | Planned | No feature work merged yet. |

Useful status commands:

```bash
git worktree list
git branch --list 'v2/*' -vv
git branch --merged v2-beta
git log --oneline --decorate --graph --all --branches='v2/*'
```

After a feature branch is merged and no longer needed locally:

```bash
git worktree remove .slim/worktrees/v2-<feature-name>
git branch -d v2/<feature-name>
```
