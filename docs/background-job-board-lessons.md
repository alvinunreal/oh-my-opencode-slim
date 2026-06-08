# Background Job Board Lessons

This note captures what we learned while hardening background task tracking,
cancellation, session reuse, and tmux pane cleanup.

## What the Board Is For

The Background Job Board is a compact prompt reminder for orchestrator-managed
`task` delegations. It lets the orchestrator see:

- which specialist tasks are still running,
- which terminal tasks still need reconciliation,
- which completed sessions can be resumed for related follow-up work,
- what files a remembered specialist session already read.

The board is not an authority over OpenCode runtime state. It is a coordination
cache. Live OpenCode events, task output, `/session/status`, and session
delete/abort behavior can disagree, so cancellation and reuse must be defensive.

## Correct Prompt Contract

The board prompt should say:

```text
Do not poll running jobs. Reconcile terminal jobs before final response.
Reuse only completed sessions for the same specialist/context; never reuse
cancelled or errored sessions.
```

The older wording was unsafe:

```text
Reuse any non-running session for the same specialist/context.
```

That allowed cancelled/error sessions to appear as reusable, for example:

```text
#### Reusable Sessions
- ora-1 / ses_... / oracle / cancelled, reconciled
```

Cancelled and errored sessions are terminal, but they are not good continuation
targets. They may contain partial state, aborted streams, or a failed prompt loop.
Reusable sessions should be **completed and reconciled only**.

## Cancellation Is Not Just Board State

Marking a job `cancelled` is not enough. The child OpenCode session can continue
running after the board says cancelled if we only trust plugin-local state.

The reliable cancellation flow is:

1. Resolve the job by parent-scoped alias or raw `ses_...` ID.
2. Call `session.abort` to interrupt the active prompt runner.
3. If the SDK supports it, call `session.delete` immediately after abort.
4. Verify that the session is no longer busy.
5. Only then mark the board job as cancelled and unreconciled.

`session.abort` alone can produce a temporary idle event while the background
task loop later starts another prompt step. `session.delete` is the stronger
operation for cancellation because it removes the child session and emits
`session.deleted`.

## `/session/status` Can Be Misleading

During testing, `/session/status` sometimes returned a map that did not include
the child session, which looks like idle/missing, while the event stream later
showed the same session was still busy.

Implication:

- Do not treat one missing status-map entry as proof of termination.
- Use live `session.status` events to update `lastLiveBusyAt` in the job board.
- If any busy event is observed after cancellation begins, the session is not
  safely cancelled.
- Prefer `session.delete` over a long idle polling window for explicit user
  cancellation.

## Transient Task Errors Are Ambiguous

OpenCode can return:

```text
Task is not running in this process and has no final output.
```

That does not always mean the child task is done. It can mean the task is not
known to the current process while the session is still live elsewhere.

Treat this as a transient process-local error when there is evidence the session
is still running. Do not terminalize the job or launch a duplicate specialist
just because this error appeared.

## Pane Cleanup Has Cross-Instance Races

The multiplexer session manager keeps shared in-memory state for tracked panes.
Multiple plugin instances can observe the same OpenCode event stream. Owner
gating is useful for ordinary idle/missing cleanup, but it caused a race for
deleted sessions:

1. Child pane was spawned by instance A.
2. `session.delete` emitted `session.deleted`.
3. Instance B saw the delete event first.
4. Instance B skipped close because it was not the owner.
5. The pane remained visible until instance A later received another idle event.

For `session.deleted`, any instance that sees the event should close the tracked
pane by shared pane ID. Keep owner gating for normal idle/missing cleanup, but
not for deletion.

## Reconciliation Rules

- Running jobs: wait for hook-driven completion.
- Terminal unreconciled jobs: mention/reconcile before final response.
- Completed + reconciled jobs: may be reusable if the same specialist/context
  matches.
- Cancelled/error jobs: hide from reusable sessions after reconciliation.
- Cancelled writer tasks: inspect partial file changes before replacing the lane.

## Useful Debug Logs

When debugging cancellations, search plugin logs under
`~/.local/share/opencode` for:

- `[cancel-task] request received`
- `[cancel-task] abort call returned`
- `[cancel-task] deleting session after unstable abort`
- `[cancel-task] session delete returned`
- `[cancel-task] delete verification status`
- `[task-session-manager] busy observed after cancel request`
- `[multiplexer-session-manager] session deleted, closing pane`
- `[multiplexer-session-manager] closing deleted pane as non-owner`
- `[tmux] closePane`

The important question is not whether `cancel_task` returned a cancelled-looking
message. The important question is whether the logs show the child session was
deleted and the pane close path ran.

## Practical Takeaways

- Board state is advisory; OpenCode session lifecycle is authoritative.
- `abort` interrupts work; `delete` terminates the child session lifecycle.
- Hook-driven completion is the normal path; explicit lifecycle checks are only
  supporting evidence when diagnosing cancellation or pane cleanup.
- Event-backed state catches runtime behavior that status maps can miss.
- Prompt wording matters: “non-running” was too broad; “completed only” is the
  safer reuse contract.
- Pane cleanup must handle multi-instance event races, especially on
  `session.deleted`.
