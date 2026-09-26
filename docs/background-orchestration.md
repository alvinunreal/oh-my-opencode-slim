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
| `task_status` | Check the status of a tracked task |
| `task_result` | Retrieve a tracked task's result |
| `task_message` | Queue a non-interrupting message and return `queued` |
| `task_cancel` | Stop a generation while retaining its session |
| `task_revive` | Resume a retained session with a new instruction |
| `wait_for_user` | Plugin-provided orchestrator tool that pauses automatic orchestrator wakes while the user performs external manual work |

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

### Unattributed sessions and restart scope

A child observed before it can be attributed to a task launch is retained as a
provisional placeholder. It remains resolvable by task ID or alias for
`task_status`, but is omitted from the operational Background Job Board listing.
A stopped placeholder does not trigger a stopped-job recovery wake for its parent:
it is not yet known to be delegated work. Attribution through the existing task
launch path promotes it to an ordinary listed task, including recovery wakes.
This distinction uses explicit provenance, not agent names or description text.

Newly launched aliases are stored in a per-project private local identity index
when writable; if reservation fails, the board uses the exact task ID instead.
After restart, reuse requires verification against the host; the index alone is
not proof of a reusable child. Pre-upgrade aliases cannot be reconstructed, but
an exact task ID can be checked against structured parent delegation and host
session evidence. This preserves the identity and context of an existing child,
not proof that its latest run finished. Recovery remains partial, not a
restoration of full history.

A native synthetic completion with no plugin provenance is not, by itself,
proof that the parent received or acknowledged that child's result. For a
verified completed child after restart, a successful `task_result` with text
matching the current child run confirms parent consumption immediately;
same-ID continuation needs no later `finish: stop`. Native completion results
and plugin-origin notifications can also establish confirmation when followed
by a qualifying parent `finish: stop` turn.

After that matching retrieval, later user and system messages, text-only
assistant messages, a refused `task()` or `subagent()` whose error or output
contains `no new session was created` or `resume blocked` (matched
case-insensitively), and a stop with no text leave the confirmation intact.
A later message created in the same millisecond as the retrieval's end is
evaluated by its contents; an earlier, missing, or future creation time blocks
confirmation. The other parts of the parent message containing `task_result`
are checked too: a failed `bash` or an already completed other
`task()`/`subagent()` blocks that retrieval, while a successful ordinary tool with no error, or a host `patch` part,
leaves it intact. OpenCode 1.18.32 appends `patch` to the same assistant
message when the step changes files. The part is not confirmation by itself.

An in-flight `task()` or `subagent()` call in `running` or `pending` state has
not admitted a prompt and leaves that confirmation intact. A pending or
running `read`, `bash`, or `grep` part with empty `part.error` and `state.error`
also preserves it, including alongside the current `task()` call.

OpenCode 1.18.32 records a missing explicit `description` as a pre-dispatch
`SchemaError`. The string form contains `SchemaError`, `description`,
`Missing key`, and `at ["description"]`; the equivalent object form is
`{ name: "SchemaError", message: "Missing key at [\"description\"]" }`.
Either form leaves the confirmation intact. A missing `subagent_type` or other
`SchemaError` blocks confirmation unless its error or output also says `no new
session was created` (case-insensitively), which identifies a pre-dispatch
refusal.

The following still block confirmation or reuse: a `task()` or `subagent()`
that actually dispatched a prompt, whether it completed or failed; a failed
ordinary tool; an empty tool state; an unknown part other than a host `patch`;
another ended child task; and a child in `busy`, `retry`, `error`,
`cancelled`, or `stopped` state.
Before parent confirmation, an explicit `task_id` is refused without
creating a session. A dispatched `task()` or `subagent()` blocks another prompt
for the same child.

### Recovery limitations

The `running`/`pending` exception classifies only the current task call as
unadmitted; it cannot establish whether another parallel child has already
crossed its send boundary.

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
`task_message` queues a non-interrupting message and returns `queued`; it does
not stop the current generation. Use `task_cancel` to stop a generation while
retaining its session, then inspect and reconcile any partial file changes before
launching replacement work. Use `task_revive` to resume a retained session with a
new instruction.

A cancelled, errored, or stopped retained session may be revived immediately
once its retained state has been verified safe. Acknowledgement controls parent
and job-board consumption and reusable-pool display, not same-session revival.
`task()` never drops an explicit `task_id` to spawn another session.
After a host restart, `task_revive` also needs current-run host idle proof; a
preserved session alone cannot authorize a new instruction.

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
history is rehydrated into the local job board and reconciled against available
host evidence. Where live status is available, a missing or idle child is a stop
candidate: after a 5s confirmation grace it is surfaced as `stopped,
unreconciled`, while a busy child remains running; status lookup failures remain
uncertain. When the host client exposes `session.get`, each newly rehydrated task
is also probed for existence: a session deleted while the plugin was down is
tombstoned and torn down instead of resurrecting as a forever-running ghost.
An attributable terminal host outcome can settle an existing child; mere
existence cannot (the typed NotFound classification is a v2 in-process artifact
— on v1 hosts the probe harmlessly never tombstones). On
OpenCode v2 hosts with the optional `ctx.storage` domain, deletion tombstones
and alias counters additionally persist across host restarts (see the
[v2 compatibility doc](opencode-v2-compatibility.md#background-job-state-rehydrate-probe-and-persistence)).

Explicit `task_id` reuse after restart is fail-closed: a stored alias or exact
ID must resolve to the same parent's child through durable identity and claim
state. Completed-after-restart same-ID continuation also needs an attributable
terminal result for that child's current run, fresh real host status confirming
quiescence, and parent confirmation: either a matching successful `task_result`
retrieval, or native completion output or a plugin-origin notification followed
by a qualifying parent stop. Retrieval confirms immediately; the other paths
require the later stop. Neither a transcript ending nor an unattributed native
synthetic completion supplies those proofs. If alias reservation fails, use the
exact task ID: with a readable index but no mapping, it can be checked via
structured parent delegation. An alias without its mapping cannot be recovered;
an unreadable index fails closed.

The tested OpenCode 1.18.32 v1 server entrypoint exposes a real
`session.status` map. Its embedded v2 plugin pass may abort on a reduced setup
context; that does not turn the v1 server path into a statusless v2 host. On a
different host, OpenCode v2.0.15, `Session.Info.outcome`, `time.idle`, and a
durable idle message are not persisted. After restart, `session.get` lacks run
status and `wait`/active state was process-local; `time.updated` cannot prove
the current run completed. On that host an orphan `task_result` remains `pending`
without attributable current-run host idle proof, even if identity and context
survive. A host with the necessary evidence can use matching `task_result`
retrieval as immediate parent confirmation for same-ID continuation; native
completion and plugin-origin notification still use the later parent-stop path.
`task_revive` cannot bypass missing current-run idle proof. An unknown explicit
ID is never dropped to spawn a replacement; a truly missing child requires an
explicit new task without `task_id`. Restart recovery is not automatic.

There is one deliberately narrower same-process exception. Within one plugin
setup generation, the terminal gate records a completed/error/cancelled
publication with its exact board generation and terminal revision. After the
parent retrieves the matched result, a private, non-persisted resume token may
authorize one same-ID `task()` admission on a statusless v2.0.15 host. The token
is fenced by the child admission, generation, terminal revision, and result
text; a new admission, plugin disposal, ambiguous send, or host restart
invalidates it. This does not make v2.0.15 restart recovery automatic and does
not authorize `task_message` or `task_revive` without their own host evidence.

The control tools share the same recovery boundary. `task_status` may perform a
read-only report for a verified exact session ID even when no durable alias can
be adopted; it marks that result as read-only and does not make it eligible for
`task_message` or `task_revive`. `task_message` only writes to a verified live
child, while `task_revive` only writes to a verified retained child and never
aborts an orphan merely because its session record still exists. Before either
write, a bounded child-transcript baseline read and a durable operation claim
are required. Claims use token-fenced phases (`prepared`, `sent_unknown`,
`accepted`, and `compensating`): deterministic pre-send failures and explicit
host rejections may clear a claim, but a timeout or generic transport failure
keeps the claim quarantined until admission is proven or safely compensated.

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
After restart, verification also requires attributable current-run idle proof;
retention alone does not make revival safe.

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

The scheduler does **not** perform automatic cancellation and does not rely on
the local job board. When no incomplete TODOs remain, it ends the current idle
spell and stops polling until new activity.

**v2 hosts (children-driven degraded mode):** v2 has no todo/children/status
surfaces, so with `mode: "auto"` the scheduler runs in children-driven mode.
The wake condition becomes "children without a terminal `outcome`" where the
host exposes it (succeeded|failed|interrupted), plus pending stopped-job
recovery. Pinned v2.0.15 does not persist `outcome` across restarts. Children
are enumerated via `session.list({parentID})` (event-tracked fallback from
`session.created` links when the listing is unavailable), scoped to the
session's directory. A child with no fresh update evidence (host
`time.updated` or a tracked status change within 3× the interval) counts as
inactive. Freshness is a watchdog heuristic, not current-run completion proof.
The wake prompt asks the orchestrator to check on unfinished background child
sessions and unreconciled jobs. It is delivered with `queue` semantics (like
v1's queued prompt_async); the children-only fingerprint bounds cost with a
two-wake no-progress cap. v2's native subagent completion nudges still cover
the happy path; this watchdog covers stuck children and unreconciled jobs.

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

When the current child run's trailing assistant message has `info.error` as an
`Error` instance or ordinary object whose `name` is exactly
`MessageAbortedError`, terminal publication submits `stopped` rather than
`error`; string errors and other error objects remain `error`. A live `busy` or
`retry` observation still takes precedence and does not submit `stopped`.
`task_revive` can still return `status_uncertain` while the preceding evidence
read remains open.

Stopped-job recovery facts are checked again by task ID and run generation
before a queued recovery wake is delivered. The inline detail queue is bounded;
when it overflows, the wake carries an explicit overflow signal directing the
orchestrator to inspect all unreconciled stopped jobs on the board.

`task_status` applies a separate reporting rule. When a successful read returns
a valid status map with no entry for the session, it reports a certain board
state of `completed`, `error`, `cancelled`, `reconciled`, or `stopped` when
that record's own `statusUncertain` is not `true`; it does not append
`(unconfirmed)` or report `no live status entry`. A missing entry is never
reported as `idle`, while live `busy`, `retry`, or explicit `idle` takes
precedence. Running board records, failed or timed-out reads, malformed
entries, and uncertain records remain unconfirmed. The coordinator continues
to use the existing 5s confirmation grace before recording a running task as
`stopped, unreconciled`.

Malformed status entries and failed status requests are surfaced as `status
uncertain`; they never prove that a job stopped or completed and do not confirm
a pending stop. Each observation is generation-aware, so a delayed response
cannot modify a relaunched task.

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
