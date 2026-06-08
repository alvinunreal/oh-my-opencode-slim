# src/hooks/task-session-manager/

## Responsibility

Provides V2 background job-board state for `task` output and injected completion messages so the
orchestrator can track active jobs and reuse only completed, reconciled child
sessions by short aliases (`exp-1`, `ora-2`).

## Design

- `createTaskSessionManagerHook(ctx, options)` returns handlers for:
  - `tool.execute.before`
  - `tool.execute.after`
  - `experimental.chat.messages.transform`
  - `event`
- Uses `BackgroundJobBoard` from `src/utils/background-job-board.ts` as the
  single source of truth for active jobs, terminal unreconciled jobs, reusable
  completed sessions, aliases, read context, and LRU caps.
- Task labels are derived from `description`/`prompt` via
  `deriveTaskSessionLabel` and stored on job-board records.
- In-flight calls are tracked by `callID` in a capped ordered map
  (`MAX_PENDING_TASK_CALLS`) to correlate launch output safely.

## Flow

1. `tool.execute.before` receives `task` calls.
2. `task.task_id` aliases resolve only to completed/reconciled jobs for the same
   specialist; misses remove `task_id` to force fresh task creation.
3. `tool.execute.after` registers launches and status transitions from native V2
   output; bare task IDs without state do not create reusable jobs.
5. Read context from child sessions is attached to board records with line-count
   and file caps.
6. `experimental.chat.messages.transform` injects one `### Background Job Board`
   section with Active / Unreconciled and Reusable Sessions subsections.
7. Parent idle events reconcile terminal jobs only after they have been injected
   into the prompt.
8. `session.deleted` drops a child job or clears all parent jobs and pending call
   records.

## Integration

- Wired in `src/index.ts` for before/after tool hooks, message transforms, and
  lifecycle events.
- Depends on `BackgroundJobBoard`, task-output parsing utilities, plugin
  configuration (`backgroundJobs` caps), and runtime session filtering from
  `src/index.ts` (`shouldManageSession`).
