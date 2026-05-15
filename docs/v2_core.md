# V2 Core Refactor Plan

This document is the implementation plan for the V2 orchestration core.

Scope for this pass:

- core prompts,
- scheduler/job-board behavior,
- `task` and `task_status` integration,
- task-session-manager changes,
- tmux/zellij multiplexer compatibility,
- todo-continuation guardrails.

Out of scope for this pass:

- Divoom integration,
- install/startup flag checks,
- README/index documentation updates,
- legacy fallback behavior.

V2 assumes native OpenCode background subagents are available and enabled.

---

## Core Thesis

V2 changes the orchestrator from a worker-with-delegation into a scheduler.

V1 mental model:

```text
orchestrator works directly → delegates when useful → waits for result
```

V2 mental model:

```text
orchestrator plans → dispatches background specialists → monitors jobs
→ reconciles terminal results → verifies final state
```

The orchestrator should not be the default implementation worker. Specialists do
the work; the orchestrator manages the work.

---

## Native Background Task Lifecycle

OpenCode background task semantics are the foundation:

```text
task(background: true)
  → returns immediately with task_id
  → child session continues elsewhere
  → task_status(task_id) reports running or terminal state
  → orchestrator consumes terminal result
```

Important distinction:

- `task` result means **launched**.
- `task_status` terminal result means **finished**.
- Finished is not the same as reconciled.

V2 must model these as separate states.

---

## Core State Model

Introduce a small scheduler/job-board model for background delegates.

Suggested state shape:

```ts
type BackgroundJobState =
  | 'running'
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'reconciled';

interface BackgroundJobRecord {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description: string;
  objective: string;
  ownership?: string[];
  dependencies?: string[];
  state: BackgroundJobState;
  launchedAt: number;
  updatedAt: number;
  completedAt?: number;
  timedOut?: boolean;
  terminalUnreconciled?: boolean;
  resultSummary?: string;
}
```

Native `task_status` states are `running`, `completed`, `error`, and
`cancelled`. A wait timeout is not a terminal native state; represent it as a
`timedOut` overlay while the job remains `running`.

This does not need to be persisted initially. Start in memory, scoped to the
parent orchestrator session.

Start with minimal reliable fields:

```ts
{
  taskID,
  parentSessionID,
  agent,
  description,
  objective,
  state,
  timedOut,
  terminalUnreconciled,
  launchedAt,
  updatedAt,
  completedAt,
  resultSummary,
}
```

Keep `ownership` and `dependencies` advisory until there is a reliable data
source. Native `task` arguments do not contain those fields, so initial V2 should
not pretend the plugin can infer them perfectly.

### Shared scheduler module

Do not bury this state inside `task-session-manager`.

Create a small shared utility, for example:

- `src/utils/background-job-board.ts`, or
- `src/hooks/scheduler-state/` if it grows into a hook-owned subsystem.

It should expose methods such as:

```ts
registerLaunch(record)
updateStatus(taskID, status)
markReconciled(taskID)
hasRunning(parentSessionID)
hasTerminalUnreconciled(parentSessionID)
formatForPrompt(parentSessionID)
```

Then pass the shared state into:

- task-session-manager,
- todo-continuation,
- any future prompt/system-context hook that needs scheduler state.

### Reconciliation rule

The plugin needs one concrete reconciliation transition.

Initial rule:

1. `task_status` or an auto-injected completion message marks a job terminal and
   `terminalUnreconciled: true`.
2. The next orchestrator assistant turn after that terminal result is treated as
   the reconciliation turn for all terminal unreconciled jobs visible in context.
3. On orchestrator assistant turn completion, when the parent session returns to
   idle after that assistant response, mark the terminal unreconciled jobs that
   were injected into that turn's prompt as `reconciled`.

This is intentionally simple. It avoids terminal jobs living forever while still
forcing at least one orchestrator turn to see and account for each result.

**Important:** Idle-based reconciliation is a heuristic. Reconciled status means
a terminal result was injected into an orchestrator turn that completed and the
parent returned to idle; it is not proof the result was explicitly acknowledged
or used by the orchestrator. Initial V2 should not try to infer from free text
whether the orchestrator mentioned, ignored, blocked, or failed a job. If a more
precise protocol is needed later, add an explicit marker/tool for reconciliation.

---

## Prompt Refactor

Primary file:

- `src/agents/orchestrator.ts`

Related reminder file:

- `src/config/constants.ts`

### Role rewrite

Replace the current role framing with scheduler-first language:

```text
You are a workflow manager for coding work. Your job is to plan, schedule,
delegate, monitor, reconcile, and verify specialist-agent work. You are not the
default implementation worker.
```

The orchestrator may directly:

- ask clarifying questions,
- read minimal context required to route work,
- manage todos,
- dispatch specialists,
- poll task status,
- synthesize results,
- run final checks when that is the simplest verification path.

The orchestrator should delegate:

- broad search,
- external docs/API research,
- implementation,
- test writing or test updates,
- UI polish,
- architecture review,
- visual/media analysis.

### Replace blocking execution section

Remove the V1 text that says delegated specialists block the parent until result.

New execution model:

```text
### OpenCode V2 scheduler model
- Delegated specialists should be launched as background tasks whenever work can
  run independently using `task(..., background: true)`.
- A dispatch returns a task/session ID immediately; it does not mean completion.
- Track each task ID with specialist, objective, state, and any advisory
  ownership/dependency labels available from the dispatch plan.
- Continue orchestration while tasks run: planning, scheduling independent lanes,
  preparing synthesis, and asking needed user questions.
- Poll or wait with `task_status(wait: true, timeout_ms: ...)` before consuming
  outputs or starting dependent work.
- Parallel background tasks are allowed only when their write scopes do not
  conflict.
- Final response requires relevant tasks to be terminal and reconciled.
```

### Replace execute workflow

V2 workflow should be:

```text
## Dispatch
1. Split work into independent and dependency-ordered lanes.
2. Plan advisory ownership for write-capable lanes.
3. Dispatch independent specialists as background tasks.
4. Record task IDs, state, and advisory ownership/dependency labels.
5. Continue only independent orchestration while jobs run.
6. Poll/wait for terminal results with task_status.
7. Reconcile results, resolve conflicts, and gate dependent lanes.
8. Dispatch follow-up jobs if needed.
9. Verify final state.
```

### Phase reminder rewrite

Update `PHASE_REMINDER_TEXT` so it reinforces scheduler behavior:

```text
Build a short work graph with independent lanes, dependencies, and advisory
ownership.
Dispatch independent specialists as background tasks, record task/session IDs,
then continue orchestration. Poll task_status and only consume outputs or advance
dependent work when results are terminal.
```

---

## Task Prompt Contract

Each background task prompt should be self-contained and bounded.

Include:

- objective,
- constraints,
- relevant files or search scope,
- ownership boundaries,
- whether edits are allowed,
- expected output format,
- validation expectations,
- what not to do.

Good prompt:

```text
Inspect src/hooks/task-session-manager for assumptions that a task result means
child work is finished. Do not edit files. Return exact files/functions,
background-task risks, and recommended changes.
```

Bad prompt:

```text
Look into background tasks.
```

---

## Task Session Manager Refactor

Primary files:

- `src/hooks/task-session-manager/index.ts`
- `src/utils/task.ts`
- `src/utils/session-manager.ts`

Current behavior:

- `tool.execute.before` tracks `task` calls.
- `tool.execute.after` parses a `task_id` from output.
- the parsed ID is immediately remembered as a resumable session.
- there is no terminal/non-terminal distinction.

V2 behavior:

- `task` tool output creates or updates a job as `launched` or `running`.
- `task_status` output updates the job to `running`, `completed`, `error`, or
  `cancelled`; timeout is metadata while the job remains `running`.
- only terminal jobs become ready for reconciliation.
- only reconciled/appropriate sessions should be offered for reuse.

### Required changes

1. Split parsing helpers:

   ```ts
   parseTaskLaunchOutput(output) → { taskID, state: 'running' | ... }
   parseTaskStatusOutput(output) → { taskID, state, result? }
   ```

2. Store background job records in a shared scheduler/job-board module scoped by
   parent orchestrator session.

3. Update `tool.execute.after` for `task`:

   - parse launch output,
   - register job as launched/running,
   - do not treat it as completed.

4. Add handling for `task_status`:

   - parse status output,
   - update job state,
   - attach result summary for terminal states.

5. Update system-context injection:

   - replace or augment `### Resumable Sessions` with `### Background Job Board`,
   - include compact running/terminal unreconciled jobs,
   - keep aliases short.

6. Do not expose running background jobs as resumable sessions. A running job
   alias should nudge `task_status`, not `task(task_id=...)`. Only completed and
   reconciled sessions should enter the old resumable-session pool.

---

## Background Job Board Prompt Context

The orchestrator needs a compact view of active work.

Target injected shape:

```text
### Background Job Board
Use task_status before consuming running jobs. Reconcile terminal jobs before
final response.

- exp-4 / ses_abc / explorer / running
  Objective: Map multiplexer flow
  Ownership: read-only
  Dependencies: none

- fix-2 / ses_def / fixer / completed, unreconciled
  Objective: Update task-session-manager task_status handling
  Ownership: src/hooks/task-session-manager/**
```

Keep this small. The point is scheduling state, not full task transcripts.

---

## `task_status` Integration

Primary files:

- `src/index.ts`
- `src/hooks/task-session-manager/index.ts`

Add hook support for the native `task_status` tool.

Target flow:

```text
tool.execute.after(task_status)
  → parse task_id + state
  → update job board
  → if terminal, attach compact result summary
  → mark as terminal/unreconciled
```

The orchestrator prompt should then see terminal jobs and reconcile them before
continuing dependent work.

Do not rely only on OpenCode auto-resume notifications. The plugin should build
its own compact scheduler state from tool results and events.

### Auto-injected completion path

Native background tasks can also complete through an OpenCode-injected parent
message instead of an explicit `task_status` call. V2 must ingest that path too.

Parse this in the chat/message transform path that already inspects parent
conversation messages, most likely `experimental.chat.messages.transform` in the
same hook family as task-session-manager context injection. If native OpenCode
adds a dedicated event later, move the parser to that event path.

Add parsing for synthetic completion content containing fields like:

```text
Background task completed: <description>
task_id: <id>
state: completed | error

<task_result>
...
</task_result>
```

That path should update the same shared job-board state as `task_status`.
Initially parse verified auto-message states only. `cancelled` can still be
handled through explicit `task_status` output unless verified in auto-injected
messages.

```text
auto-injected completion message
  → parse task_id + state + result
  → update job board
  → mark terminal/unreconciled
```

---

## Multiplexer Integration

Primary files:

- `src/multiplexer/session-manager.ts`
- `src/multiplexer/tmux/index.ts`
- `src/multiplexer/zellij/index.ts`
- `src/index.ts`

Current multiplexer behavior is already close to V2:

- child session created → spawn pane,
- child session busy → ensure pane exists,
- child session idle/deleted → close pane,
- fallback polling checks `/session/status`.

V2 requirements:

1. Panes represent child sessions, not parent blocking state.
2. Parent may continue while panes run.
3. Pane title should make background work understandable.
4. Cleanup should be tied to actual child session idle/deleted state, not parent
   task-tool return.
5. Tests should cover long-running background children and delayed completion.

Likely first implementation can keep close-on-idle if native child sessions emit
accurate idle events. Verify with real background tasks before changing cleanup
semantics.

Potential later improvement:

```text
[BG explorer] exp-4 Map multiplexer flow
[BG fixer] fix-2 task-session-manager
```

---

## Todo Continuation Guardrails

Primary file:

- `src/hooks/todo-continuation/index.ts`

Risk:

- parent orchestrator becomes idle while background jobs are still running,
- auto-continuation assumes the workflow can proceed or finish,
- dependent work advances too early.

V2 rule:

```text
If relevant background jobs are running, continuation should poll/reconcile them
instead of treating the workflow as complete.
```

Implementation direction:

- expose a `hasRunningBackgroundJobs(parentSessionID)` query from the scheduler
  state,
- expose `hasTerminalUnreconciledJobs(parentSessionID)`,
- have continuation reminders nudge toward `task_status` and reconciliation.

---

## Agent Lane Reframing

V2 should describe specialists as execution lanes, not optional helpers.

- Explorer: discovery lane.
- Librarian: external knowledge lane.
- Fixer: implementation lane.
- Designer: UI/UX lane.
- Oracle: review/risk/architecture lane.
- Council: high-stakes decision lane.
- Observer: visual/media lane.

The orchestrator schedules lanes according to dependency and ownership.

---

## Implementation Phases

### Phase 0 — Pre-Prompt Groundwork

Before changing the prompt, build enough parser/job-board behavior that the
prompt can rely on visible scheduler state.

### Phase 1 — Parser And Job Board Core

- add task launch/status parsers,
- parse only `task` output with `state: running` as a background launch,
- add shared in-memory scheduler state,
- keep timeout as an overlay on `running`, not a native state,
- keep ownership/dependencies advisory until reliable.

### Phase 2 — Prompt Core

- rewrite orchestrator role,
- rewrite execution model,
- rewrite dispatch workflow,
- update phase reminder,
- reframe specialists as lanes.

### Phase 3 — Prompt Job Board Injection

- inject compact job board into orchestrator context.

### Phase 4 — `task_status` Handling

- hook `task_status`,
- update job states from status output,
- mark terminal jobs as unreconciled,
- keep running jobs visible.

### Phase 5 — Auto-Injected Completion Handling

- parse OpenCode background completion messages,
- update the same shared job board,
- prevent jobs from staying stale when the parent auto-resumes.

### Phase 6 — Reconciliation Transition

- mark terminal jobs injected into a prompt as reconciled after the next
  orchestrator assistant turn completes and the parent session returns idle,
- test this transition directly.

### Phase 7 — Session/Mux Safety

- verify tmux/zellij pane lifecycle with real background tasks,
- add tests for delayed completion,
- adjust close-on-idle only if native events prove insufficient.

### Phase 8 — Todo Continuation Safety

- prevent auto-continuation from finalizing while jobs run,
- nudge the orchestrator to poll terminal states and reconcile.

---

## First Code Targets

Start here:

1. `src/utils/task.ts`
   - task launch/status parsing helpers.

2. `src/utils/background-job-board.ts` or equivalent shared scheduler module
   - background job state, queries, reconciliation marking, prompt formatting.

3. `src/hooks/task-session-manager/index.ts`
   - register launches/statuses with the shared job board and avoid exposing
     running jobs as resumable sessions.

4. `src/index.ts`
   - route `task_status` after-hooks into the task-session-manager hook.

5. `src/agents/orchestrator.ts`
   - prompt role and workflow rewrite after scheduler state exists.

6. `src/config/constants.ts`
   - phase reminder rewrite.

7. `src/multiplexer/session-manager.test.ts`
   - add V2 lifecycle tests once behavior is understood.

---

## Success Criteria For Core V2

Core V2 is working when:

- orchestrator prompt consistently schedules rather than implements,
- background `task` output registers running jobs,
- `task_status` terminal output updates job board state,
- orchestrator context shows running and terminal unreconciled jobs,
- dependent work waits for terminal results,
- prompt-level advisory ownership reduces conflicting background workers,
- multiplexer panes show background child sessions while parent continues,
- todo-continuation does not finalize with unresolved background jobs.

The core invariant:

```text
task creates jobs; task_status or auto-completion finishes jobs; orchestrator
reconciles jobs.
```
