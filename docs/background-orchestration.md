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

## Inspecting unsuccessful children

`task_status` with `diagnostic: true` returns a read-only, bounded, non-final
excerpt for a tracked child that ended in error, cancelled, or stopped. Running
children are refused (`result: true` is for completed children), and an owned
but untracked handle returns ordinary status plus a notice instead of an excerpt.
Unavailable or ambiguous evidence is reported, never invented: attribution is
timestamp-based because most runs lack recorded message identities, tool inputs
and successful tool outputs are excluded, and host compaction is omitted and
labelled. The rendered response is capped at 6,144 UTF-8 bytes, including
headers and truncation markers.

A diagnostic read is evidence, not consumption or acceptance: it never
reconciles or resumes the child. `last_activity_source` explains the activity
timestamp (`observed-activity` may lag, `host-busy` is coarse, `launch-time`
means no evidence beyond launch, `unknown` means none). See the
[tool reference](tools.md#background-task-control) for the full contract.

---
## Runtime Requirement

Background orchestration needs an OpenCode release with native background
subagents and hook-driven completion, started with background subagents
enabled:

```bash
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true opencode
```

The tools, their v1/v2 differences, and the `task()`/`subagent()` vocabulary are
listed in [Tools](tools.md#background-task-control). Without the environment
variable the default background workflow is unavailable: configure it through
the installer (see [Installation](installation.md)) or use the one-shot export
above, and confirm the release with `opencode --version`.

Setting `backgroundJobs.enabled: false` turns this managed layer off entirely:
the `task_*` control tools and `wait_for_user` are not registered, and no job
board, retention, terminal gate, watchdog, wake scheduler, or startup recovery
runs. Native `task`/`subagent` delegation and host completion delivery keep
working exactly as OpenCode provides them, so council seat assembly and
ordinary background delegation still function — only the OMOS bookkeeping and
control surface disappear. See [Configuration](configuration.md).

There is no automatic legacy fallback: missing background-subagent support is an
environment or version problem, not an intentional v1 mode.

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
`task_status`. The destination directory handles its own permissions and runtime
profiles; unrelated sessions remain excluded from the parent's event handling.

### Unattributed sessions and restart scope

A child observed before it can be attributed to a task launch is retained as a
provisional placeholder. It remains resolvable by task ID or alias for
`task_status`, but is not treated as delegated work by the plugin.
A placeholder does not trigger stopped-job recovery or completed/error publication
wakes for its parent, including after repeated executions: it is not yet known to
be delegated work. This lets another plugin own a child session's notifications.
Attribution through the existing task launch path promotes it to an ordinary
listed task, including recovery and publication wakes.
This distinction uses explicit provenance, not agent names or description text.

Aliases and reusable-session history are process-local and do not survive process
restarts as a reusable board. Post-restart recovery is partial and best-effort;
it does not guarantee restoration of those aliases or the complete history. Two
read-only channels work after a restart: a background launch's marker in the
parent's history still resolves its alias when it is the final non-empty line of
that tool result (tail-anchored only), and `task_status` reports a read-only
observed state for an owned session the board no longer tracks — completed or
uncertain running-or-incomplete from transcript evidence (unknown when the
live status read fails), never claiming definite running — pointing to a `task_status` result read for completed text; it never
re-registers or prompts the task. One recovery channel is explicit:
`task_revive` on a raw session ID verifies the
session against the host (existence and parent ownership) and re-adopts an
untracked child owned by the calling parent, then
continues it with the new prompt. A fourth channel is implicit: an
untracked child that reports idle or error is adopted under its recorded
managed parent by an observation fallback (below), so its terminal outcome
still wakes the parent.
Recovery verifies the original agent and latest delivered round before importing
a retained terminal row. This cache-only import does not launch or notify.
On V2, `session.execution.interrupted` with reason `shutdown` is suspension,
not a terminal idle transition. OMO preserves the raw event without synthesizing
idle/status events; the host retains execution and first-notification ownership.
This does not restore process-local board entries or prove restart recovery.
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
unverified or ambiguous aliases remain refused. On-demand recovery uses the
session's host outcome: a terminal round is imported, and a round without a
terminal outcome (still running, or awaiting the host's restart resume) is
refused except for an explicit queued revive. An assistant created after the
host idle means the terminal does not cover the latest transcript activity, so
the round stays pending. Startup recovery is unchanged and still classifies
persisted transcript idles. An explicit queued revive can adopt identity before
a previous round's idle is visible; that adoption is not terminal evidence, so
recovery never imports the round from it. The host wakes an idle session or
runs the input after the current execution; revival does not wait for idle or
interrupt it.
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

Background tasks are not complete until the host injects their terminal result
or a hook-driven completion marks them terminal. Use `task_status` to inspect a
task and `task_status` with `result: true` to collect its result; a result read
is a read, not a required step before every continuation.

- `task_message` (v1 only) sends a non-interrupting, queue-only message
  (`noReply`, `resume: false`). It never wakes, steers, resumes, or interrupts
  the child, and acceptance does not mean the child read it. To steer a running
  child on v2, use the native delegation call (`subagent(sessionID, prompt)`).
- `task_cancel` stops a generation and retains its session. Inspect and
  reconcile partial file changes before launching replacement work.
- `task_revive` (v1 only) resumes a retained session after its state is verified
  safe, in the same child. v2 continues through the native delegation call. No
  path drops an explicit resume id to spawn another session.

Terminal reconciliation proves lifecycle state, not that the output was used:
verify that the relevant result was consumed before finalizing. Parent
notifications are best-effort with a 10-second transport wait per attempt; a
timeout can still duplicate a delivery, and acceptance is not an exactly-once
guarantee.

A brand-new `task` spawn is refused while the parent still owns an unreconciled
terminal job with the same agent and an exactly matching objective; the refusal
names the existing task ID and points at `task_status` with `result: true`.
Once that result is retrieved, the same objective may be dispatched again.

The orchestrator wake scheduler (v1 only; v2 creates none) may prompt an idle
parent with incomplete todos after continuous idle time; it does not depend on
the job board.

After a plugin or OpenCode restart, persisted launch identities (task ID,
parent, agent, objective, launch time, delivery marker) and, on v2, the host's
own re-delivery of a background subagent outcome restore running and terminal
children without replaying ones already delivered. Recovery is idempotent:
board presence, generation fences, and the delivery marker prevent a second
adoption or duplicate wake, and deletion tombstones prevent resurrecting a
child deleted while the plugin was down. A missing or idle child is surfaced as
`stopped, unreconciled` after a 5-second grace; timeouts stay unknown, never
completion. The recovery and fencing rules are documented in
[Background job state](opencode-v2-compatibility.md#background-job-state-rehydrate-probe-and-persistence),
and the tools themselves in [Tools](tools.md#background-task-control).

A child the board never re-adopted (for example one launched before this
recovery existed) is also covered: when it reports idle or error with no
board row, an observation fallback adopts it under its recorded managed
parent and reconciles the outcome, so the owed wake still reaches the
parent. The fallback skips children that are themselves managed, already
delivered, or hold a deletion tombstone; an idle adoption terminalizes as
`stopped, unreconciled` like any other child idle, and an error publishes
the failure.

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

The runtime treats background tasks as a small job board (machine state only —
it is never rendered into a prompt):

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
been verified safe. Acknowledgement controls parent consumption
and reusable-pool display, not same-session revival. Stopped sessions stay out
of the ordinary `task()` reuse pool because that generation has no terminal
result; after ack they are retained for `task_revive`.

The current todo list can represent user-visible work, but task IDs and file
ownership need to be explicit in the orchestrator's working context.

---

## Runtime Integration

The plugin is aware that a `task` return can mean "background job launched"
rather than "work complete". It tracks running task IDs, updates aliases from
task results, and keeps multiplexer panes attached while the parent orchestrator
continues scheduling. The job board is plugin-internal state: it is never
rendered into a prompt (issue #1647); `task_status` is the read surface.

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
`mode` selects the v1 wake condition: `"auto"` (default) always uses
todo-gating; explicit `"todo"` falls back to children where the todo API is
absent, and `"children"` selects children-driven mode. Set `enabled: false` to disable wakes while keeping idle reconciliation
and background-job orchestration.

This whole section is **v1-only**: on OpenCode v2 hosts the plugin creates no
wake scheduler at all — the native background notifier owns terminal delivery
(council 2026-10-23) — and every `backgroundJobs.orchestratorWake` key warns
as ignored there.

Behavior:

- Per-session recursive `setTimeout(...).unref()` after continuous parent-idle
  time (never a global interval).
- Only sessions known as the parent `orchestrator` via session metadata.
- Host client APIs are authoritative (`session.get`, `todo`, `children`,
  `status`, `promptAsync` with the nested directory request shape). The local
  job board is never read or used as a gate.
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

**v2 hosts: no scheduler.** On OpenCode v2 the plugin creates no wake
scheduler at all (council 2026-10-23): the native background notifier owns
terminal delivery, restart recovery re-delivers anything lost, and the
parent discovers open child asks via `task_status` pull.

#### v2 structural defaults

On v2 the host's native background notifier already delivers each run's first
terminal result (completed, error, cancelled): an idle parent gets a new turn, a
busy parent gets a steer. Two plugin channels would duplicate that, so they are
structurally off, not configurable:

- the job board is never injected into a prompt (true on v1 too; the render was
  removed in #1647, and `backgroundJobs.boardInjection` no longer exists);
- no wake scheduler is created: every `backgroundJobs.orchestratorWake` key is
  v1-only, and an explicit value is ignored with a load-time warning.

On v1, event-driven wakes still run (stopped-job recovery, later terminal
publications of the same run, child-input asks), with SDK-error retries on the
idle timer; failed publication retries survive parent busy/idle transitions.
Later-result wakes carry `task_status { sessionID, result: true }` pointers in a
tagged volatile message, so the parent never has to guess from delegation
history. Child-input wakes wait 250 ms, and per-kind policy applies: by default
only question asks wake the parent (#1504). Permission asks that stay parked are
visible through `task_status`; set
`backgroundJobs.childInputWakeKinds.permission = true` or rely on
`wallClockTimeoutMs` when no UI or responder will answer them. On v2 no
child-input wake is sent: asks are pull-only via `task_status`.

Terminal retirement is observation-based on both hosts: the plugin retires the
exact run (generation- and revision-fenced) when it observes the delivery that
reported it — the native `<subagent>` delivery on v2, its own tagged
`<completed-job>` push on v1, or the revived-run notification. A completed,
error, or cancelled record also retires once the parent demonstrably moves past
the terminal report. Stopped jobs are not retired that way (a stop has no native
notification): they stay stopped and unreconciled, the stopped-job recovery wake
reports them, and `task_revive` acknowledges them. Reopen corrections tell the
parent once not to rely on the earlier result.

For external manual work, the orchestrator gives concrete steps and then calls
`wait_for_user` as its final tool action; the wait is cleared only by a distinct
real external user message or genuine session deletion. Synthetic messages,
replayed user messages, fallback teardown, session errors, and idle/busy events
do not clear it. Immediate choices and clarifications use the `question` tool.
`wait_for_user` is v1-only: on v2 the orchestrator always uses the native
`question` tool.
### No Job Board In The Prompt

The job board is never rendered into a prompt — on any host. It stays a
machine-side projection: dedupe by objective, alias authority, stall tracking,
the terminal gate, session adoption, and generations keep working, but no
prompt surface lists them. There is no switch to turn the render back on; the
`backgroundJobs.boardInjection` key was removed with the render.

Terminal facts travel as one-shot pushes instead:

- The host's native notifier delivers a run's FIRST terminal publication
  (completed, error) to the parent on both host versions. The plugin publishes
  nothing beside it.
- A later publication of the same run (rev>1: a child that self-continued, or
  a direct prompt to the child session) has no native notifier. On v1 the
  plugin pushes ONE self-contained `<completed-job>` delta (alias, task, state,
  result) through the same bounded delta queue the stopped-job recovery uses,
  so the result survives a busy parent. The push honors the per-parent
  publication spacing (`publicationWakeMinIntervalMs`) by deferring, not
  dropping: results inside the window stay queued and one wake delivers them
  together when it elapses.
  The wake that carries it is a bare resume pointer: the delta holds the
  facts. On v2 the plugin sends no wake for it: a later run relaunched
  through the `subagent` tool is delivered natively, and any other later
  result is pulled with `task_status`.
- Overflowed pushes keep a durable pointer to `task_status` instead of
  listing the coalesced facts inline.

### Runtime status and session eviction

Liveness is read from the host, never inferred: a session that `session.status`
reports as busy or retrying is live, and an unreadable or timed-out read stays
**unknown** — never "finished". Startup listing, session-info, and transcript
waits are each bounded at 5 seconds; a stalled list falls back to persisted
identities and never blocks later children.

`pruneEvictedSessions` (v1 only — v2 exposes no live status map, so every prune
is skipped there) may delete the host child of an evicted record. It only
considers background children this plugin launched, and re-checks immediately
before deleting: a bounded `session.get` must report the same `parentID`, a
bounded `session.status` must report idle, and the board must not track the
task again. Parked child-input waits, adopted or restored sessions, and explicit
`clearParent`/`drop` evictions are never pruned. The delete itself has the same
deadline, and every read plus the delete is bounded, so a revive waiting on an
in-flight prune always settles. Tombstones are consumed at most once and fence
startup adoption.
### Admission and supervision

Three opt-in knobs shape background execution; keys, defaults, and the exact
rules live in [Configuration](configuration.md#background-job-management).

- **Concurrency** caps running native background tasks (`0` = unlimited; the
  most specific cap wins: model > provider > default). Nested managed tasks are
  exempt, and admission has no timeout, so pair it with the watchdog.
- **Same-provider conversion** (`sameProviderPolicy`) turns an explicit
  background call into the foreground path when parent and child share the
  configured local backend, avoiding KV-cache thrash.
- **Wall-clock watchdog** (`wallClockTimeoutMs`) aborts a supervised child at
  the deadline and lets the host publish the real terminal. There is no
  confirmation timeout (`abortGraceMs` was removed).
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
