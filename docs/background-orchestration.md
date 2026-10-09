# Background Orchestration

Background orchestration is the default orchestration model for
oh-my-opencode-slim. It assumes native OpenCode background subagents are
available and changes the orchestrator from a primary worker into a scheduler.

The old model was:

```text
orchestrator works directly → delegates when useful → waits for result
```

The default background-orchestration model is:

```text
orchestrator plans → dispatches background specialists → monitors → reconciles → verifies
```

This is a clean rebuild, not a compatibility layer over the old blocking model.

---

## Runtime Requirement

Background orchestration requires an OpenCode release that includes native
background subagents, launched with background subagents
enabled:

```bash
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode
```

The task API and background-control tools are:

| Tool | Purpose |
|------|---------|
| `task(..., background: true)` | Start a specialist in the background and immediately return a task ID |
| hook-driven completion | OpenCode injects terminal background task results automatically |
| `task_status` | Check the status of a tracked task (read-only fallback for owned untracked sessions after a restart) |
| `task_result` | Retrieve a tracked task's result |
| `task_message` | Send a non-interrupting message and return `queued` (v2: steering acceptance with `delivery: "steer"`) |
| `task_cancel` | Stop a generation while retaining its session |
| `task_revive` | Resume a retained session with a new instruction |
| `wait_for_user` | Plugin-provided orchestrator tool that pauses automatic orchestrator wakes while the user performs external manual work |

The delegation tool named `task()` here is `subagent()` on v2, with
`task_id`/`sessionID` as the matching resume id; bare `task()` mentions on this
page refer to that host-specific delegation tool.

If these are not available, the scheduler cannot use the default background
workflow. Configure the environment variable through the installer or use the
one-shot export above before starting OpenCode.

Use an OpenCode release that includes native background subagents and hook-driven completion; run `opencode --version` and update if background tasks are missing.

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

### Children moved to worktrees

Moving a child session to another directory does not move its task ownership.
The delegating parent's plugin instance still observes that tracked child's
lifecycle, so completion and revived-run notifications do not require polling
`task_result`. The destination directory handles its own permissions and runtime
profiles; unrelated sessions remain excluded from the parent's event handling.

### Unattributed sessions and restart scope

A child observed before it can be attributed to a task launch is retained as a
provisional placeholder. It remains resolvable by task ID or alias for
`task_status`, but is omitted from the operational Background Job Board listing.
A stopped placeholder does not trigger a stopped-job recovery wake for its parent:
it is not yet known to be delegated work. Attribution through the existing task
launch path promotes it to an ordinary listed task, including recovery wakes.
This distinction uses explicit provenance, not agent names or description text.

Aliases and reusable-session history are process-local and do not survive process
restarts as a reusable board. Post-restart recovery is partial and best-effort;
it does not guarantee restoration of those aliases or the complete history. Two
read-only channels work after a restart: a background launch's marker in the
parent's history still resolves its alias when it is the final non-empty line of
that tool result (tail-anchored only), and `task_status` reports a read-only
observed state for an owned session the board no longer tracks — completed or
uncertain running-or-incomplete from transcript evidence (unknown when the
live status read fails), never claiming definite running — pointing to `task_result` for completed text; it never
re-registers or prompts the task. One recovery channel is explicit:
`task_revive` on a raw session ID verifies the
session against the host (existence and parent ownership) and re-adopts an
untracked child owned by the calling parent, then
continues it with the new prompt.
Recovery verifies the original agent and latest delivered round before importing
a retained terminal row. This cache-only import does not launch or notify.
`task_cancel` still cannot abort a run launched before the restart — the board
has no live handle to it (tracked in #1387).
The production board numbers a parent's children only when the host's creation
time shows that parent session was created while the plugin instance runs: the
board saw every numbered alias it could have. Any other parent (created before a
restart, or with no creation time) gives its new children their exact session
ID as alias, and task creation still succeeds. This is deliberate: no cheap host
read bounds the numbers issued before a restart. The live child count misses
deleted children and a persisted high-water mark can miss a failed write, so
either floor could hand an old `fix-2` to a new child while history still pairs
`fix-2` with another session. Adopted and rehydrated host children keep their
session ID as alias; a restored child keeps its historical alias only when
history pairs that alias with it alone and no row of that parent holds it
(never once the parent's readable history is cut: a v2 compaction or,
on v1, more than 1,000 messages).
None of them consumes a new number. A forked session counts as new, but the
aliases in its copied history belong to the original parent: refer to the
fork's new children by exact session ID.

The continuation guidance changes the static orchestrator prompt and board
wording. Existing sessions incur a one-time prompt-cache re-warm on their
first request with this version; this is not a cache-neutral release. The
new guidance remains deterministic and does not rewrite earlier messages.

On v2 hosts with `session.prompt` and `session.context`, adoption queues the new
instruction in the same session after shared recovery verifies parent ownership,
agent evidence, and readable history. Host-proven aliases use the same path;
unverified or ambiguous aliases remain refused. An incomplete historical round
is permitted only for this explicit queued revive; ordinary recovery still
requires a verified historical terminal. The host wakes an idle session or runs the input
after the current execution; revival does not wait for idle or interrupt it.
The plugin assigns a message ID before admission and only delivers the terminal
answer after that exact input. An older execution's result, error, or idle event
cannot complete the continuation. Missing input/answer evidence remains pending.
Only one continuation is admitted locally at a time. An uncertain admission must
not be retried: its lease stays held until acknowledgement or an attributable
answer proves completion. Queued adoption does not arm a session-wide timeout
abort, because that could kill the preceding execution. Deletion suppresses late
delivery without a compensating interrupt. V1 adoption retains its live-status
gate; existing tracked revival retains its previous idle-verification behavior.

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
Wait for hook-driven completion
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

### 4. Wait, message, cancel, and revive

Background tasks are not complete until OpenCode injects their terminal result or
hook-driven completion marks them terminal.

The orchestrator should use background completion events to:

- wait for dependent results,
- check long-running tasks,
- collect outputs before final response,
- surface failures or blocked tasks clearly.

Use `task_status` to inspect a task and `task_result` to collect its result.
`task_result` is a read, not a required step before every continuation.
`task_message` sends a non-interrupting message and does not stop the current
generation. On v2 it accepts an optional `delivery`: the default `"queue"`
waits for an idle boundary — `resume: false` never wakes the child, so
consumption is not confirmed — while `"steer"` offers an amendment to a
running lane at the next supported step boundary of the current run. On v1
the parameter does not exist and the message is simply queued, returning
`queued`. On either host, acceptance does not mean the child read it —
report acceptance without claiming consumption, reconcile the amendment
against the child's eventual result, and never resume, cancel, or relaunch
the running child just to deliver an amendment. Use `task_cancel` to stop a generation while
retaining its session, then inspect and reconcile any partial file changes before
launching replacement work. On v1, continue an existing session with
`task_revive` even when it is missing from Reusable Sessions. A new task still
uses `task()` without an id. `task_revive` verifies the host session and
continues in that same child; it does not spawn a replacement.

A cancelled, errored, or stopped retained session may be revived immediately
once its retained state has been verified safe. Acknowledgement controls parent
and job-board consumption and reusable-pool display, not same-session revival.
The delegation tool (`task()` on v1, `subagent()` on v2) never drops an explicit
resume id (`task_id` on v1, `sessionID` on v2) to spawn another session.

Terminal jobs are reconciled automatically after their result is injected into
the orchestrator session. That lifecycle state is not proof the output was used;
the orchestrator must still verify it consumed the relevant result before
finalizing.

Parent terminal notifications are best-effort, with retries bounded by the
existing notification policy (a zero retry budget still permits the initial
send). Each transport wait is limited to 10 seconds. No notification attempt
retains its lifecycle lease after that local wait ends, even if the host call
never settles; other lifecycle operations still enforce their own safety checks.
A timeout does not cancel a notification already queued by the host, so an
ambiguous outcome can produce duplicate deliveries if a retry also succeeds.
Acceptance of any attempt for the same current publication suppresses further
retries, including a late acceptance while another attempt is pending. This
records host acceptance, not parent consumption or job-board reconciliation;
it is not an exactly-once delivery guarantee.

To stop self-reinforcing acknowledgment loops, a brand-new `task` spawn is
refused while the parent still owns an unreconciled terminal job with the same
agent and an exactly matching objective. The refusal names the existing task ID
and directs the caller to `task_result`; once that result has been retrieved,
the same objective may be dispatched again for follow-up work.

Separately, the default-on orchestrator wake scheduler may prompt an
idle parent with incomplete todos after continuous idle time; it does not depend
on the local job board.

After a full OpenCode or plugin restart, persisted running background-task
history is rehydrated into the local job board and immediately reconciled against
live host session status. A missing or idle child is a stop candidate: after a
5s confirmation grace it is surfaced as `stopped, unreconciled`, while a busy
child remains running; status lookup failures remain uncertain rather than being
treated as completion. When the host client exposes `session.get`, each newly
rehydrated task is also probed for existence: a session deleted while the plugin
was down is tombstoned and torn down instead of resurrecting as a
forever-running ghost, and a session that already reached a terminal host
outcome is settled to it (the typed NotFound classification is a v2
in-process artifact — on v1 hosts the probe harmlessly never tombstones). On
OpenCode v2 hosts with the optional `ctx.storage` domain, deletion tombstones
and epochs additionally persist across host restarts (see the
[v2 compatibility doc](opencode-v2-compatibility.md#background-job-state-rehydrate-probe-and-persistence)).

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

---

## Specialist Roles

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

---

## State The Orchestrator Must Track

The prompt/runtime treats background tasks as a small job board:

| Field | Meaning |
|-------|---------|
| task ID | Native OpenCode background task/session ID |
| specialist | Agent type assigned |
| objective | What the task is responsible for |
| state | running; stopped (runtime ended without terminal task output); completed, error, or cancelled (explicit terminal task output); reconciled (terminal result consumed) |
| ownership | Files/folders/subsystems the task may edit |
| dependencies | Tasks that must complete first |
| result | Final task output once terminal |
| status certainty | `status uncertain` when the live status map is malformed or unavailable; it never implies completion |

Cancelled, errored, and stopped sessions can remain retained for a later
`task_revive`. They may be revived immediately once their retained state has
been verified safe. Acknowledgement controls parent and job-board consumption
and reusable-pool display, not same-session revival. Stopped sessions stay out
of the ordinary `task()` reuse pool because that generation has no terminal
result; after ack they appear under Retained / Recovery.

The current todo list can represent user-visible work, but task IDs and file
ownership need to be explicit in the orchestrator's working context.

---

## Runtime Integration

The plugin is aware that a `task` return can mean "background job launched"
rather than "work complete". It tracks running task IDs, exposes recent work in
the background job board, updates aliases from task results, and keeps
multiplexer panes attached while the parent orchestrator continues scheduling.

### Orchestrator wake scheduler

When an orchestrator parent stays continuously idle, the plugin may send a
periodic internal wake prompt so incomplete TODOs are not abandoned. This is
**enabled by default** with a **5-minute** interval:

```jsonc
{
  "backgroundJobs": {
    "orchestratorWake": {
      "enabled": true,
      "intervalMs": 300000,
      "mode": "auto"
    }
  }
}
```

`intervalMs` must be an integer from `60000` to `2147483647`. `0` is invalid.
`mode` selects the wake condition: `"auto"` (default) uses todo-gating on v1
hosts and children-driven mode on v2 hosts; `"todo"` and `"children"` pin one
mode (an explicit `"todo"` degrades to children on hosts without the todo
API). Set `enabled: false` to disable wakes while keeping idle reconciliation
and background-job orchestration.

Behavior:

- Per-session recursive `setTimeout(...).unref()` after continuous parent-idle
  time (never a global interval).
- Only sessions known as the parent `orchestrator` via session metadata.
- Host client APIs are authoritative (`session.get`, `todo`, `children`,
  `status`, `promptAsync` with the nested directory request shape). The local
  Background Job Board is never read or used as a gate.
- Wake requires valid host response shapes, parent currently idle, and at least
  one TODO with status `pending` or `in_progress`. Unknown/malformed status
  fails closed. **Active children do not suppress a wake.**
- Suppress/clear on question/permission input waits, `wait_for_user`, foreground
  fallback, session busy, session deletion, external user messages, and server
  disposal.
- `session.time.archived` is authoritative when available. Archived sessions do
  not receive periodic or stopped-job-recovery wakes; archive updates cancel
  timers and stale evaluations, while an unarchive permits future lifecycle
  activity. v2 hosts without `session.get()` use observed session updates.
- One in-flight evaluation/wake per session. Status/waits/generation are
  rechecked immediately before `promptAsync`. Cooldown/reservation is recorded
  before the call so a failed `promptAsync` cannot storm retries.
- Default-on safety: the scheduler evaluates a bounded host-progress fingerprint
  (TODO statuses plus child status/update evidence) to decide whether to keep
  waking. After **two** successful wakes with an unchanged fingerprint, further
  wakes stop for that continuous idle spell. A real external user message or
  host-observed progress re-arms the cap. Busy caused by the wake itself does
  **not** rearm the cap; unrelated busy/error lifecycle events do. The wake
  prompt text is static and does **not** include a fingerprint or snapshot.
  The no-progress caps live in a process-global wake gate that the plugin's
  dispose hook clears on instance teardown, so a recreated plugin generation
  (for example after `opencode reload` on v2 hosts) starts with fresh caps
  instead of inheriting the previous generation's.
- Static wake text (internal initiator part via `promptAsync` only — no message
  transform injection or history rewrite):

```text
<system-reminder>
Finish any incomplete TODOs. Await running agents; if one appears stuck, assess it and cancel/respawn only when justified. Do not respond to this reminder.
</system-reminder>
```

If the same delta-less wake body was already delivered in the session, the
repeat sends a strictly shorter, non-identical marker instead
(`Repeat wake #N:`) so identical reminder bytes are not
persisted repeatedly; delta-bearing wakes and child-input asks always carry
the full template.

The scheduler does **not** perform automatic cancellation and does not rely on
the local job board. When no incomplete TODOs remain, it ends the current idle
spell and stops polling until new activity.

**v2 hosts (children-driven degraded mode):** v2 has no todo/children/status
surfaces, so with `mode: "auto"` the scheduler runs in children-driven mode.
The wake condition becomes "children without a terminal `outcome`" — v2
records an outcome (succeeded|failed|interrupted) only on terminal transition —
plus pending stopped-job recovery. Children are enumerated via
`session.list({parentID})` (event-tracked fallback from `session.created`
links when the listing is unavailable), scoped to the session's directory, and
a child with no fresh update evidence (host `time.updated` or a tracked status
change within 3× the interval) counts as inactive. The wake prompt asks the
orchestrator to check on unfinished background child sessions and unreconciled
jobs, is delivered with `queue` semantics (like v1's queued prompt_async), and
the children-only fingerprint keeps the two-wake no-progress cap bounding
cost. v2's native subagent completion nudges still cover the happy path; this
watchdog covers stuck children and unreconciled jobs.

#### v2 lean defaults

On OpenCode v2 hosts the host's native background notifier already delivers
each run's first terminal result (completed, error, or cancelled) to the
parent: an idle parent gets a new turn, a busy parent gets a steer. Two plugin
channels would duplicate that delivery, so on v2 they default **off** unless a
config layer sets them explicitly:

- `backgroundJobs.boardInjection` — the passive Background Job Board is not
  injected into orchestrator prompts.
- `backgroundJobs.orchestratorWake.periodicWakeEnabled` — the periodic idle
  evaluation described above never runs.

Event-driven wakes keep working: stopped-job recovery, later terminal
publications of the same run (for example a child that self-continued), and
child-input asks still wake an idle parent, and their SDK-error retries still
use the idle timer. v1 hosts are unchanged. To restore the previous behavior
on v2, set the keys explicitly:

```jsonc
{
  "backgroundJobs": {
    "boardInjection": true,
    "orchestratorWake": { "periodicWakeEnabled": true }
  }
}
```

Child-input wakes wait 250 ms before notifying the parent, on both host
versions. Requests answered during that window by the host, a UI auto-replier,
or another caller are discarded. Requests still open are checked again before
delivery. Duplicate events enrich the queued notice without restarting the
deadline. Stopped-job recovery and terminal-publication wakes are not delayed.
An ask arriving during a host read or model-selection lookup defers a
child-input-only wake until settling completes, without sending a stopped-job
notice in its place.

With the board off, the plugin still retires natively delivered results: on
the parent's next real user turn they are registered, and once the prompt
advances they are reconciled. Stopped jobs are **not** retired that way,
because a stop has no native notification. They stay stopped and
unreconciled, so the stopped-job recovery wake still reports them, and
`task_revive` acknowledges them when the parent resumes the work. The
recovery wake and overflow notices point at `task_status` instead of the
board. Reopen corrections are still delivered with the board off, in a
board-free variant that points at `task_status`: if a reconciled job reopens
to running, the parent is told once not to rely on its earlier result.

For external manual work, the orchestrator first gives the user concrete steps,
then calls `wait_for_user` as its final tool action. This explicit signal covers
text-only HITL turns without attempting to infer intent from assistant prose. The
wait remains armed across hook/plugin recreation in the same process and is
cleared only by a distinct real external user message or genuine session
deletion. Re-observing the user message that preceded the wait, synthetic/internal
messages (including foreground-fallback replays), fallback teardown, session
errors, and idle/busy events do not clear it. Immediate choices, clarifications,
and pasted command output continue to use the `question` tool. If
`wait_for_user` is intentionally listed in `disabled_tools`, the orchestrator
uses the `question` tool as the blocking boundary instead.

### Background Job Board Injection

By default, `latest` freezes one board part per eligible turn and replays
earlier parts without a cap; it does not replace prior boards. When the board
has not changed and contains no new terminal result, it freezes a short
"unchanged" marker instead, refreshing the full board every tenth turn.
Terminal results always get a full board. Retained parts disappear on process
restart, compaction, revert, or session deletion.

For long-lived processes, opt in to the bounded, checkpoint-compatible strategy:

```jsonc
{
  "backgroundJobs": {
    "strategy": "checkpoint-compatible",
    "maxRetainedSnapshots": 20
  }
}
```

`checkpoint-compatible` preserves prior board snapshots and appends a snapshot
anchored after the current real-message tail only when the formatted board
changes. Once created, snapshots are replayed on every managed turn, including
turns with an internal initiator or an empty board; those turns do not create a
new snapshot. Re-running injection with an unchanged board does not create a
duplicate. This changes board message history only; task coordination, storage,
terminal reconciliation, and reusable-session behavior remain unchanged. The
retained snapshot cache is in memory, is limited to 20 snapshots per cache epoch,
and is reset when OpenCode reports a session boundary or a compacted/rebased
message history. `maxRetainedSnapshots` controls
the epoch size and accepts integers from 1 to 100 (default `20`). When a changed
snapshot would exceed the configured limit, all retained snapshots are discarded
and only the new current snapshot is kept. This intentionally creates one cache
miss at the epoch boundary, after which a fresh run of up to the configured limit
can accumulate. The cache is lost on plugin restart, so snapshots are not
restored beyond those present in the current OpenCode message history.

### Runtime Liveness Reconciliation

The job board is a local projection; OpenCode's live session-status map is the
liveness authority. After a tracked task launches, the plugin periodically
checks that single map for every board job still marked `running`, while normal
session events remain the fast path.

`busy` and `retry` confirm that a job is live and reset any pending stop
confirmation. An explicit `idle` state or an absent session in an otherwise
valid map is not immediately terminal: the first observation starts a 5s
confirmation grace and keeps the job `running, status uncertain`. Repeat
non-busy evidence after that grace records `stopped, unreconciled` rather than
`completed`: it means execution ended before a native terminal task result was
delivered, not that the task succeeded. Stopped sessions are never reusable
through `task()` and stay visible to the parent for recovery with `task_revive`.
A later live `busy` observation can revive an unreconciled stopped job. After
the parent has been woken and the stop acknowledged, stale busy cannot flip the
job back to running; the session remains listed under Retained / Recovery until
revived or evicted. Only explicit terminal task output proves completion, error,
or cancellation.

Stopped-job recovery facts are checked again by task ID and run generation
before a queued recovery wake is delivered. The inline detail queue is bounded;
when it overflows, the wake carries an explicit overflow signal directing the
orchestrator to inspect all unreconciled stopped jobs on the board. With board
injection off, the overflow signal instead lists the overflowed task IDs that
are still stopped (up to 64 per parent, with a note for any beyond that) so
the orchestrator can check each with `task_status`.

Malformed status entries and failed status requests are surfaced as `status
uncertain`; they never prove that a job stopped or completed and do not confirm
a pending stop. Each observation is generation-aware, so a delayed response
cannot modify a relaunched task.

### Terminal-Session GC

Retention trims are the only board mechanic that evicts acknowledged terminal
records: the per-agent count caps and context-budget caps over reusable and
retained-stopped entries. All four trim paths share one eviction choke point —
suppression tombstone, board delete, then the optional GC listener.
`backgroundJobs.pruneEvictedSessions` (default `false`; see
[Configuration](configuration.md#background-job-management)) gates what happens
next: when enabled, the evicted record's host child session is removed through
the session-remove path (capability-probed; hosts without `session.remove`
degrade to a logged no-op)). On OpenCode v2 hosts there is no live session-status map, so the
idle check cannot pass and every prune is skipped (logged as `not-idle`):
the option currently reclaims sessions on v1 hosts only.

A host session is deleted only when every one of these holds:

- the record is terminal or retained-stopped and was actually evicted by a
  trim;
- the record is a background launch (`background: true`); foreground task
  children are never deleted;
- the record is not provisional, and never was: an unattributed
  `session.created` placeholder under a managed parent may be a session this
  plugin did not create, so it keeps its host session even after a later
  promotion;
- this plugin's own tracked native task call launched the child as a fresh
  background run (not a `task_id` resume). Sessions adopted by `task_revive`,
  adopted terminal host children, sessions restored from the parent
  transcript (`restoreRetainedSession`), and records rehydrated after a
  plugin reload carry external provenance and are never deleted;
- no parked child-input wait exists (an open question or permission request
  on the child blocks removal);
- immediately before the delete, a bounded host `session.get` (same timeout as
  runtime status reads) returns the session and its `parentID` equals the
  record's parent session. A read failure, timeout, missing parent, or
  mismatch skips the delete;
- a bounded host `session.status` read shows the session idle (or absent
  from the live status map). Busy, retry, malformed, or failed reads skip the
  delete;
- the board does not track the task again, checked both before and after the
  host reads: a session that was re-registered, revived, adopted, or leased
  after the eviction is live work and keeps its host session.

The delete itself has the same deadline and is aborted when it expires. An
error-returning, falsy, or timed-out delete is logged as a failed prune, not
a success. Every read and the delete are bounded, so the in-flight prune that
`task_revive` waits on always settles, and recovery waits on it only for a
bounded interval before asking for a retry. Two eviction paths are deliberately excluded:
`clearParent` (parent `session.deleted`) and explicit `drop` — both can evict
running or unreconciled records whose host sessions are still live. There is
no wall-clock TTL, no polling, and no startup sweep: GC runs only where
retention already decided to evict.

Each tombstone is consumed at most once. A post-pruning revive by raw session
ID is fenced three ways: a transient host read failure never touches the
tombstone (only a confirmed host 404 counts as absence); the caller's parent
transcript must show it actually delegated the task before any ending is
disclosed or the tombstone is consumed; and a tombstone without a recorded
terminal state (stopped eviction or drop) yields a result-free "no longer
tracked" refusal. Verified owners of ended tasks get the ending state
("completed" / "ended in state X") and are pointed at this session's
transcript instead of the recorded result. A revive whose host read races the
asynchronous prune delete awaits the in-flight prune (bounded) and re-reads
before adopting. Residual crash window: the host `session.remove` can land
before the tombstone's asynchronous persistence flush, in which case a
restart loses both the session and its recorded result; the transcript
remains the source of truth.

### Background Task Concurrency

`backgroundJobs.concurrency` (disabled by default, see
[Configuration](configuration.md#background-job-management)) caps how many
native background tasks may run at once. Admission happens in the
`tool.execute.before` hook: a task waits for a slot before OpenCode creates
its child session. Queued requests are admitted in order, but requests whose
resolved cap is saturated are skipped in favor of admittable later requests.

Only the most specific configured cap applies to a task: a model cap wins
over a provider cap, which wins over the default cap. `0` means unlimited.
So `modelConcurrency: {"openai/gpt-4o": 10}` permits 10 concurrent
`openai/gpt-4o` tasks even when `defaultConcurrency` is lower; other OpenAI
models fall back to `providerConcurrency` (or the default) instead.

The scheduler keeps its accounting correct across two runtime events:
- A task that switches models mid-flight (foreground model fallback or a
  runtime `/model` change on the child session) moves its provider/model
  accounting to the new model instead of keeping the admission-time model.
- The scheduler is process-scoped, so a plugin re-init (the plugin factory
  re-runs on config updates) preserves both running slots and queued
  tickets. Deleting a parent orchestrator also releases its children's
  admission slots, so capacity is never leaked by recursive-delete ordering.

Sessions that are themselves managed tasks — a background subagent running
its own nested `task(..., background: true)` calls — are exempt from
admission. They already hold a slot while running, so waiting for a second
one would self-deadlock once the queue saturates.

Admission itself has no timeout. A running task that never reaches a terminal
state keeps its slot forever, and queued tasks as well as the orchestrator's
`task` calls block behind it. When you enable `concurrency`, pair it with the
opt-in wall-clock supervisor below so stalled tasks are eventually forced to
a terminal state and release their slots.

### Same-Provider Foreground Conversion

`backgroundJobs.sameProviderPolicy` (see
[Configuration](configuration.md#background-job-management)) is an opt-in
per-provider policy for local inference backends that execute multiple
logical agent sessions on one shared model runtime (one accelerator, one
KV-context pool). Running a foreground parent and a same-provider background
child concurrently on such a backend can reduce throughput from repeated
model/KV context switching between the two large sessions:

```jsonc
{
  "backgroundJobs": {
    "sameProviderPolicy": {
      "lm-nexus": "foreground"
    }
  }
}
```

When the parent session's current model and the child agent's resolved model
both resolve to a provider configured with `"foreground"`, the
`tool.execute.before` hook rewrites the explicit
`task(..., background: true)` request to `background: false` before the
pending call is created. The task then runs through the existing foreground
path unchanged: it skips background concurrency admission (no semaphore
slot), is not wall-clock supervised, executes synchronously on the host, and
its status is registered through the existing foreground bookkeeping.
Unconfigured providers, different providers, and undeterminable providers
leave `background: true` untouched (fail-open); the default (omitted)
behavior is unchanged.

### Opt-in Wall-clock Supervisor

The plugin can apply a one-shot wall-clock deadline to native background task
child sessions. It is disabled by default:

```jsonc
{
  "backgroundJobs": {
    "wallClockTimeoutMs": 900000,
    "abortGraceMs": 10000
  }
}
```

This supervisor recognizes only an explicit `task(..., background: true)` call.
Foreground tasks and calls where `background` is omitted or `false` are not
supervised. The deadline begins at the first launch observation for the current
run. Duplicate `session.created`/tool-hook observations, busy activity, tool
activity, and liveness timestamps do not renew it. An explicit relaunch or reuse
starts a new run generation.

When the deadline wins a race with a real terminal transition, the board records
a persistent hard-deadline marker, marks cancellation as requested, starts the
bounded abort grace period, and issues exactly one native session abort. The
grace timer is independent of whether the SDK abort resolves, rejects, or hangs.
An error, cancellation, or child deletion during grace publishes one stable
timed-out terminal outcome. If no terminal confirmation arrives before grace
expires, the outcome is `error`, `timedOut: true`, and `statusUncertain: true`,
with a summary stating that abort was not confirmed.

Late completion, busy, retry, or error events cannot replace a published hard
timeout, and a hard wall-clock timeout is not recoverable through the existing
external task-wait timeout path. The timeout outcome remains visible to the
parent through the normal terminal-unreconciled Background Job Board flow; no
prompt or raw task-result rewrite is used. The timeout path has no multiplexer
coupling: pane lifecycle runs entirely in the TUI client and reacts only to
session events, so the former permanent logical pane-close intent was removed
together with the server-side pane lifecycle.

`wallClockTimeoutMs` accepts `0` or integers from `60000` through `2147483647`;
`abortGraceMs` accepts integers from `1000` through `60000`. This feature is
wall-clock-only: no no-progress/plateau policy, foreground fallback, model swap,
session deletion retry, or worker-death guarantee is implied.

---

## Startup Behavior

The installer and docs configure background subagents as a requirement for the
default scheduler workflow. If background subagents are
unavailable, treat it as an environment or OpenCode-version issue rather than an
intentional V1 fallback:

```text
Background orchestration requires OpenCode background subagents.
Start OpenCode with:

OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode
```

No automatic legacy fallback keeps the mental model clean.

---

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
5. Wait for the launched specialists via hook-driven completion.
6. Dispatch Fixer to implement prompt/config/hook changes with clear ownership.
7. Dispatch a second Fixer for tests if file ownership is separate.
8. Wait for implementation results.
9. Reconcile the implementation and dispatch Oracle only if remaining risk or
   uncertainty makes independent review worthwhile.
10. Run proportionate checks against the final state.
11. Report final state.

At no point does the orchestrator become the main implementer.

---

## Success Criteria

Background orchestration is working when:

- the orchestrator launches independent specialists in background by default,
- task IDs are tracked until terminal state,
- dependent work waits for real task results,
- file ownership prevents concurrent write conflicts,
- final responses only happen after reconciliation and verification,
- users see faster progress on multi-step work,
- the orchestrator context stays focused on decisions instead of worker detail.

Background orchestration is not just "parallel agents." It is a
scheduler-centered operating model for OpenCode's native background subagents.
