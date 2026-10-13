# Additional Task Lifecycle Tools

This project does not add more task lifecycle tools on top of the existing
`task_*` set (cancel, message, reply, result, status, revive, wait_for_user).
Stuck background tasks are handled by orchestrator prompt tuning plus the
existing `task_revive`, not by another tool.

## Why this is out of scope

On PR #1078 ("feat(tools): add task_steer for steering stuck running
background tasks"), alvinunreal declined the new tool:

> Don't think we need another task tool

and stated the supported approach (on #1061 and #1078):

> I'd make orchestrator prompt tune to never delegate foreground and if stuck
> task_revive should be used.

Each additional task tool widens the model-visible tool surface, adds prompt
load to every session, and duplicates lifecycle authority the job board and
the existing tools already hold. The fix for stuck tasks is prevention
(delegation rules) plus the existing recovery path.

## Prior requests

- PR #1078 — "feat(tools): add task_steer for steering stuck running
  background tasks" (closed)
- #1061 — stuck-task / foreground-delegation thread carrying the same
  recommendation