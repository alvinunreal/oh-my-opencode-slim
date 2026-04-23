# src/hooks/task-session-manager/

## Responsibility

Provides resumable-task state for `task` tool calls so orchestrator users can
resume work in a parent session by using short aliases (`exp-1`, `ora-2`) instead
of raw child session IDs.

## Design

- `createTaskSessionManagerHook(ctx, options)` returns handlers for:
  - `tool.execute.before`
  - `tool.execute.after`
  - `experimental.chat.system.transform`
  - `event`
- Internally uses `SessionManager` from `src/utils/session-manager.ts` to store
  remembered task sessions with bounded per-agent history.
- Task labels are derived from `description`/`prompt` via
  `deriveTaskSessionLabel` and converted to compact aliases by `SessionManager`.
- In-flight calls are tracked by `callID` in a capped ordered map (`MAX_PENDING_TASK_CALLS`)
  to rewrite inputs and correlate outputs safely.
- Session governance is feature-gated by `shouldManageSession(sessionID)`, allowing
  the hook to run only for orchestrator-managed sessions.

## Flow

1. `tool.execute.before` receives a `task` call.
2. If `subagent_type` is a recognized agent, it derives a short label.
3. When `task_id` is provided, it attempts resolution against remembered aliases
   for the current parent session/agent.
4. On success, `args.task_id` is rewritten to the real task ID; on miss it is
   removed to force fresh task creation.
5. The call metadata is stored in the pending-call map to correlate the
   subsequent post-tool event.
6. `tool.execute.after` reads the output task ID from `task` output text.
7. On first successful parse, it `remember()`s the task entry and associates it
   with the alias map.
8. If this call was a resume attempt, and the returned ID changed, the stale
   predecessor alias is dropped.
9. If resume returns an error like `[ERROR] Session not found`/`Session no
   session`, the predecessor alias is dropped so future commands fall back to
   fresh execution.
10. `experimental.chat.system.transform` injects a rendered block from
    `SessionManager.formatForPrompt` under `### Resumable Sessions`.
11. On `session.deleted`, the hook clears all task state for that parent session
    and removes any pending task call records for that parent.

## Integration

- Wired in `src/index.ts`:
  - invoked in `tool.execute.before`
  - invoked in `tool.execute.after`
  - injected into `experimental.chat.system.transform`
  - cleaned up in `event` on `session.deleted`
- Exposes no side effects outside hook handling and `SessionManager`.
- Depends on:
  - `SessionManager` and `deriveTaskSessionLabel` (from `src/utils/session-manager.ts`)
  - `parseTaskIdFromTaskOutput` (from `src/utils/task.ts`)
  - plugin configuration (`maxSessionsPerAgent`) and runtime session filtering from
    `src/index.ts` (`shouldManageSession`).
