# Background Orchestration

Background orchestration is the default orchestration model for
oh-my-opencode-slim. It assumes native OpenCode background subagents are
available and changes the orchestrator from a primary worker into a scheduler.

The default background-orchestration model is:

```text
orchestrator plans → dispatches background specialists → monitors → reconciles → verifies
```

The host owns delegated execution, continuation, completion delivery and
restart recovery. Slim adds scheduling guidance and a small on-demand control
surface; it does not maintain a second child-job lifecycle on OpenCode v2.

## Runtime Requirement

OpenCode **2.3.0 or newer** owns background subagents and completion delivery.
Check your version with `opencode --version`.

## Lifecycle modes

`backgroundJobs.mode` selects Slim’s task controls and preset binding.
See the [upgrade guide](v2-native-upgrade.md) for retired settings.

### native (default)

Native leaves delegation, same-session continuation, steering, execution
recovery and completion notification to OpenCode. The native `subagent` tool
creates a child, and passing its returned `sessionID` continues that child:

```text
subagent(agent, description, prompt)                    → new child
subagent(agent, description, prompt, sessionID)         → same child
```

V2 subagents always run in the background. Slim leaves the native tool
description and arguments unchanged; there is no foreground override.

Slim registers only the gaps the native model surface leaves open:

- `task_status` reads an exact owned child's latest round, trailing result, and
  pending permission request IDs when the host exposes `permission.list`. It is
  a bounded pull after a missing notice, not a poll loop. Missing or unreadable
  evidence stays `unknown`.
- `task_cancel` asks the host to interrupt the exact child's active execution.
  It reports the host's answer and never fabricates a terminal state. An idle
  child interrupt is a host no-op; the session is retained and can be continued
  by ID.
- `task_reply` answers a pending **permission** request. It verifies the child
  belongs to the caller, reads the pending request from the host, then replies.
  The V2 plugin session domain does not expose Form replies, so questions are
  answered in the host UI.
- `task_report` lets a child add a bounded progress or escalation update to the
  parent's host inbox. It is queue-only (`resume: false`): acceptance means the
  host queued the update, not that the parent read it or started a turn.

Use exact session IDs for every task control.

OpenCode owns background Job persistence and recovery. Its recovery is
at-least-once and can repeat external side effects after a crash; a standalone
embedding that does not run the host recovery sweep does not gain one from
Slim. Completion notices can still be lost or scrolled out of context, which is
why `task_status` is a pull channel.

OpenCode reports later child work too, including direct `session.prompt`
continuations outside the subagent tool. Slim adds no completion watcher.

### off

`backgroundJobs.mode: "off"` leaves delegation fully native and registers no
OMOS task tool. It also skips session-preset routing and its executor wrapper,
so no OMOS child read or model injection precedes native dispatch or
continuation. Agent inference settings selected by the configured global preset
still register at startup. See [Configuration](configuration.md).

## Core Principle

The orchestrator is not the default implementation worker.

Its job is to:

- understand the user request,
- break work into dependent and independent units,
- choose the right specialist for each unit,
- schedule background work,
- track task IDs and states,
- avoid conflicting writes,
- integrate specialist results,
- run or route final verification,
- communicate concise progress and outcomes to the user.

Specialists do the work. The orchestrator manages the work.

## Execution Loop

```text
Understand
  ↓
Plan dependency graph
  ↓
Dispatch independent specialists in background
  ↓
Track child session IDs and ownership
  ↓
Continue only independent coordination work
  ↓
Wait for host completion
  ↓
Reconcile results and resolve conflicts
  ↓
Dispatch follow-up work if needed
  ↓
Verify
  ↓
Final response
```

The orchestrator should not act on assumptions from a still-running child. It
can continue scheduling independent work, but dependent work waits for a
terminal result.

## Scheduler Responsibilities

### 1. Build a dependency graph

Before dispatching agents, the orchestrator identifies:

- which questions must be answered before implementation,
- which tasks can run in parallel,
- which tasks must be sequential,
- which files or subsystems each writer owns,
- which outputs are needed for final verification.

This does not need to be a long plan. It should be just enough structure to
avoid wasted work and conflicting edits.

### 2. Dispatch background specialists

Launch independent work through OpenCode’s native tool:

```text
subagent(
  agent="explorer",
  description="Search auth flow",
  prompt="Find the auth entry points, session storage, and login callback paths. Return file paths and a concise map. Do not edit files."
)
```

The orchestrator records the returned session ID and keeps working only on safe,
independent coordination.

### 3. Track ownership

The scheduler must prevent write conflicts.

Rules:

- Only one write-capable specialist owns a file at a time.
- Do not run two `fixer` tasks against overlapping folders unless ownership is
  explicit.
- UI work that touches shared components should not run beside implementation
  work that edits the same components.
- Review tasks can run in parallel with read-only discovery, but not with edits
  they are supposed to review.

### 4. Wait, continue, cancel, and report

A background task is complete when the host delivers its terminal result.
Use `task_status` to recover a missing notice or read a completed result; do not
poll it.

- On V2, continue the same child with `subagent(sessionID, prompt)`. Both a
  settled child and a running child use the host's Job/steering path.
- `task_cancel` asks the host to interrupt the exact child. It does not delete
  the session and does not roll back partial edits.
- `task_reply` answers a pending permission request. Answer questions in the
  host UI on V2.
- A child may call `task_report` for a material milestone or blocker. The
  update is queued to its owning parent without starting a parent turn.

Terminal reconciliation proves lifecycle state, not that the output was used:
verify that the relevant result was consumed before finalizing. Native
completion is host-owned and best-effort for delivery; acceptance of a result
read or report is not an exactly-once guarantee.

Specialist outputs are inputs, not final truth. The orchestrator reconciles them
against each other and the original user goal.

### 5. Verify

Verification remains orchestrator-owned and should be proportionate to the
change. Use focused checks against the final state, broadening them only when
risk or uncertainty warrants it. Oracle review is conditional: dispatch it for
material semantic or architectural risk, unresolved uncertainty, or another
high-cost decision—not automatically.

The final response should only happen after relevant background work is terminal,
reconciled, and supported by final-state evidence.

## Specialist Roles

### Explorer

Read-only reconnaissance, codebase mapping, and external research (docs,
version-specific API behavior, real-world examples). Usually the first
background task for unfamiliar work.

### Fixer

Bounded implementation worker. Receives a clear objective, file ownership,
constraints, and validation expectations.

### Designer

User-facing UI/UX implementation and review. Owns visual polish, responsive
layout, interaction quality, and design consistency.

### Oracle

Architecture, code review, simplification, risk analysis, and high-stakes
debugging. Often used after implementation or before risky refactors.

### Council

Multi-model decision support for critical trade-offs. It is not a worker pool;
it is for judgment where disagreement is useful.

### Observer

Visual/media analysis isolated from the orchestrator context.

## Direct Work Boundary

Background orchestration removes the orchestrator-as-worker default.

The orchestrator may directly:

- ask clarifying questions,
- read minimal context needed to route work,
- create and update todos,
- launch and monitor tasks,
- synthesize results,
- run final checks when that is cheaper than delegating.

The orchestrator should delegate:

- broad code search,
- unfamiliar library research,
- implementation,
- test creation or updates,
- UI polish,
- architecture review,
- visual/media analysis.

## Task Prompt Contract

Every delegated task should be self-contained.

Include:

- objective,
- constraints,
- relevant files or search scope,
- ownership boundaries,
- expected output format,
- whether edits are allowed,
- validation to run or report,
- what not to do.

### Task-fit rejections

If a task is outside a specialist's role, it must not attempt partial work. It
returns a brief reason to the orchestrator.
The orchestrator treats that reason as routing input to reroute or clarify the
task and must not retry the unchanged task with the same specialist.

Good background task prompt:

```text
Investigate src/hooks/task-session-manager for assumptions that a task tool
result means the child task has finished. Do not edit files. Return:
1. exact files/functions involved,
2. which assumptions break with background tasks,
3. recommended code changes,
4. tests that should be added.
```

Bad background task prompt:

```text
Look into background tasks.
```

## State The Orchestrator Must Track

The host owns child execution state. The orchestrator tracks the coordination
facts it needs:

| Field | Meaning |
|-------|---------|
| session ID | Native child session returned by `subagent` |
| specialist | Agent type assigned |
| objective | What the child is responsible for |
| ownership | Files/folders/subsystems the child may edit |
| dependencies | Children that must complete first |
| result | Final output reported by the host or read through `task_status` |

## Runtime Integration

The plugin understands that a `subagent` return can mean "background job
launched" rather than "work complete." It keeps multiplexer panes attached while
the parent orchestrator continues scheduling.

### Completion delivery

On V2, OpenCode reports each child busy period when it settles. The report
reaches the parent inbox and wakes or steers the parent; this includes native
`subagent(sessionID, prompt)` follow-ups and direct `session.prompt`
continuations. Slim adds no second completion message or delivery ledger.

### Cancellation

`task_cancel` sends the host's own interruption for the exact child.

- The host owns cleanup and any terminal publication.
- Interruption acceptance is not proof that cleanup has completed.
- An idle target is a no-op.
- A timeout or unconfirmed result is reported as unconfirmed; it may still
  land.
- The session remains continuable by ID.

### Human-in-the-loop waits

On V2, use the native `question` tool for a blocking question. A child's
permission request is visible through `task_status` and can be answered by the
parent model with `task_reply` when the request is still pending. If another
actor answers first, the reply reports that it is no longer pending.

### Restart

OpenCode owns background Job durability and recovery. On a host with the
registered recovery sweep:

- running child Jobs can be resumed,
- undelivered terminal notifications remain pending and may be delivered again,
- recovery is at-least-once, not exactly-once for external side effects.

Slim writes no V2 child/tombstone/delivery ledger. Pending permissions are
cancelled by a host reload; ask again after the child continues if necessary.
If recovery state is unavailable, `task_status` reports `unknown` rather than
inventing completion.

## Example Flow

User asks:

```text
Make background subagents first-class in this plugin.
```

The orchestrator should do something like:

1. Create todos for discovery, design, implementation, docs, tests, and
   verification.
2. Launch Explorer in background to map task-session hooks and task lifecycle.
3. Launch Oracle in background only if the change has material semantic or
   architectural risk or unresolved uncertainty.
4. Continue by preparing the dependency graph and file ownership plan.
5. Wait for the launched specialists via host completion.
6. Dispatch Fixer to implement prompt/config/hook changes with clear ownership.
7. Dispatch a second Fixer for tests if file ownership is separate.
8. Wait for implementation results.
9. Reconcile the implementation and dispatch Oracle only if remaining risk or
   uncertainty makes independent review worthwhile.
10. Run proportionate checks against the final state.
11. Report final state.

At no point does the orchestrator become the main implementer.

## Success Criteria

Background orchestration is working when:

- the orchestrator launches independent specialists in background by default,
- child session IDs are tracked until terminal state,
- dependent work waits for real task results,
- file ownership prevents concurrent write conflicts,
- final responses only happen after reconciliation and verification,
- users see faster progress on multi-step work,
- the orchestrator context stays focused on decisions instead of worker detail.
