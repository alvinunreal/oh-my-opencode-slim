# V2 Background Orchestration

V2 is the next orchestration model for oh-my-opencode-slim. It assumes native
OpenCode background subagents are available and changes the orchestrator from a
primary worker into a scheduler.

The old model was:

```text
orchestrator works directly → delegates when useful → waits for result
```

The V2 model is:

```text
orchestrator plans → dispatches background specialists → monitors → reconciles → verifies
```

This is a clean rebuild, not a compatibility layer over the old blocking model.

---

## Runtime Requirement

V2 requires OpenCode with native background subagents enabled:

```bash
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode
```

The required native tools are:

| Tool | Purpose |
|------|---------|
| `task(..., background: true)` | Start a specialist in the background and immediately return a task ID |
| `task_status` | Poll or wait for a background task result |

If these are not available, V2 should fail loudly instead of falling back to the
legacy blocking orchestration model.

---

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

---

## Execution Loop

Every non-trivial request follows this loop:

```text
Understand
  ↓
Plan dependency graph
  ↓
Dispatch independent specialists in background
  ↓
Track task IDs and ownership
  ↓
Continue only independent coordination work
  ↓
Poll / wait with task_status
  ↓
Reconcile results and resolve conflicts
  ↓
Dispatch follow-up work if needed
  ↓
Verify
  ↓
Final response
```

The orchestrator should not act on assumptions from a still-running task. It can
continue scheduling independent work, but dependent work waits for terminal task
results.

---

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

Independent work should be launched with background tasks:

```text
task(
  description="Search auth flow",
  subagent_type="explorer",
  background=true,
  prompt="Find the auth entry points, session storage, and login callback paths. Return file paths and a concise map. Do not edit files."
)
```

The orchestrator records the returned task ID and keeps working only on safe,
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

### 4. Poll and reconcile

Background tasks are not complete until `task_status` says they are terminal.

The orchestrator should use `task_status` to:

- wait for dependent results,
- check long-running tasks,
- collect outputs before final response,
- surface failures or blocked tasks clearly.

**Note on reconciliation:** Idle-based reconciliation is a heuristic. A job marked
as reconciled means its terminal result was injected into an orchestrator turn
that completed and the parent returned to idle; it is not proof the result was
explicitly acknowledged or used. The orchestrator should still verify it consumed
the relevant outputs before finalizing.

Specialist outputs are inputs, not final truth. The orchestrator reconciles them
against each other and the original user goal.

### 5. Verify

Verification remains orchestrator-owned, but not necessarily orchestrator-run.

Examples:

- route UI review to `designer`,
- route code review to `oracle`,
- route test writing or test updates to `fixer`,
- run final shell checks directly only when appropriate.

The final response should only happen after relevant background work is terminal
and reconciled.

---

## Specialist Roles In V2

### Explorer

Read-only reconnaissance and codebase mapping. Usually the first background task
for unfamiliar work.

### Librarian

External docs, version-specific API behavior, and real-world examples. Runs in
parallel with Explorer when implementation depends on current library behavior.

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

---

## Direct Work Boundary

V2 removes the orchestrator-as-worker default.

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

This keeps the main context focused on coordination instead of filling it with
worker detail.

---

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

---

## State The Orchestrator Must Track

V2 prompt/runtime should treat background tasks as a small job board:

| Field | Meaning |
|-------|---------|
| task ID | Native OpenCode background task/session ID |
| specialist | Agent type assigned |
| objective | What the task is responsible for |
| state | running, completed, error, cancelled, timed out |
| ownership | Files/folders/subsystems the task may edit |
| dependencies | Tasks that must complete first |
| result | Final task output once terminal |

The current todo list can represent user-visible work, but task IDs and file
ownership need to be explicit in the orchestrator's working context.

---

## Plugin Changes Needed

V2 is more than a prompt rewrite. The plugin should become aware that a task
tool return can mean "background job launched" rather than "work complete".

Important areas:

- `src/agents/orchestrator.ts` — replace blocking delegation language with the
  scheduler contract.
- `src/config/constants.ts` — update phase reminders so they reinforce scheduler
  behavior instead of old delegation behavior.
- `src/hooks/task-session-manager/` — track running background task IDs and
  update aliases from `task_status` results.
- `src/index.ts` task hooks — separate "task launched" from "task finished" for
  notifications, Divoom, multiplexer, and cleanup behavior.
- `src/multiplexer/` — verify panes stay attached to running background child
  sessions while the parent continues.
- `src/hooks/todo-continuation/` — avoid marking workflows complete before
  relevant background tasks have terminal results.

---

## V2 Startup Behavior

V2 should be strict.

If background subagents are unavailable, the plugin should not silently behave
like V1. It should tell the user exactly what is missing:

```text
V2 orchestration requires OpenCode background subagents.
Start OpenCode with:

OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode
```

No legacy fallback keeps the mental model clean.

---

## Example V2 Flow

User asks:

```text
Make background subagents first-class in this plugin.
```

The orchestrator should do something like:

1. Create todos for discovery, design, implementation, docs, tests, review.
2. Launch Explorer in background to map task-session hooks and task lifecycle.
3. Launch Oracle in background to review architecture risks.
4. Continue by preparing the dependency graph and file ownership plan.
5. Wait for Explorer and Oracle with `task_status`.
6. Dispatch Fixer to implement prompt/config/hook changes with clear ownership.
7. Dispatch a second Fixer for tests if file ownership is separate.
8. Wait for implementation results.
9. Dispatch Oracle for final review.
10. Run final checks.
11. Report final state.

At no point does the orchestrator become the main implementer.

---

## Success Criteria

V2 is working when:

- the orchestrator launches independent specialists in background by default,
- task IDs are tracked until terminal state,
- dependent work waits for real task results,
- file ownership prevents concurrent write conflicts,
- final responses only happen after reconciliation and verification,
- users see faster progress on multi-step work,
- the orchestrator context stays focused on decisions instead of worker detail.

V2 is not just "parallel agents." It is a scheduler-centered operating model for
OpenCode's native background subagents.
