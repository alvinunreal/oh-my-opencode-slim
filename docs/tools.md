# Tools & Capabilities

What Slim adds to OpenCode. Native tools are documented upstream; this page covers the tools Slim registers and the native calls it intercepts.

## apply_patch rescue

Slim intercepts the native patch tool — v1's `apply_patch` and v2's `patch` — before it runs. It rewrites recoverable stale patches, canonizes safe tolerant matches against the real file when unicode/trim drift is the only mismatch, keeps the authored `new_lines` bytes intact, preserves the existing file EOL/final-newline state for updates, validates malformed patches strictly before helper execution, uses a conservative bounded LCS fallback, accumulates helper state when the same path appears in multiple `Update File` hunks, blocks the call before native execution if any patch path falls outside the allowed root/worktree, and fails on ambiguity instead of guessing. It does not rewrite `edit` or `write` inputs. Disable with `disabled_hooks: ["apply-patch"]` (see [Hooks](configuration.md#hooks)).

---

## interview_submit_state

`interview_submit_state` stores the current interview state without printing the
specification or patch in assistant text. Use it once per interview turn: the
kickoff carries the full spec, and later turns carry a one-line status, an
optional unified diff against the current spec body, and questions.

## Web Fetch

Enhanced version of OpenCode's built-in `webfetch`. Overrides the default when
this plugin is active. Fetch remote pages with content extraction tuned for
docs/static sites.

| Tool | Description |
|------|-------------|
| `webfetch` | Fetch a URL with `llms.txt` probing, main-content extraction from HTML, binary save support, and a minimal conditional status header |

See the full [Webfetch documentation](webfetch.md) for parameters, output
format, caching, llms.txt probing, redirect policy, binary detection, and
implementation details.

`webfetch` blocks cross-origin redirects unless the requested URL or derived permission patterns explicitly allow them.

---

## Code Search Tools

Fast, structural code search and refactoring - more powerful than plain text grep.

| Tool | Description |
|------|-------------|
| `ast_grep_search` | AST-aware code pattern matching across 25 languages |
| `ast_grep_replace` | AST-aware code refactoring with dry-run support |

`ast_grep` understands code structure, so it can find patterns like "all arrow functions that return a JSX element" rather than relying on exact text matching.

If the ast-grep CLI is missing or cannot execute, the tools attempt automatic
recovery once, then return an error rather than retrying indefinitely.
Concurrent calls share recovery work. Missing paths are rediscovered locally
before downloading, so an installed CLI can be used offline. Only an unusable
plugin-cached binary is removed; package and system binaries are never deleted.
Downloaded Linux binaries require glibc.
On Alpine/musl, build a compatible binary locally
(`cargo install ast-grep --locked`), copy it to the plugin cache path shown in
the error, and restart OpenCode.

`ast_grep_replace` previews changes by default. Set `dryRun: false` to write
the replacements. Report-size limits do not limit which matching rewrites
are applied. Write failures and timeouts return errors instead of a successful
`[APPLIED]` report.
If the report is truncated, the output distinguishes successful writes from
dry-run previews and does not claim complete replacement or file totals.

Before the built-in `grep`/`glob` tools run, the plugin pre-checks that the
requested `path` is valid, using the same resolution rules as the host:
v1 `grep` joins relative paths, while v1 `glob` resolves them; v2 resolves
relative paths for both tools. Missing paths and paths with a non-directory
component fail fast with an actionable error instead of an opaque "ripgrep
execution failed" message or a silent search of the parent directory.
Resolution uses the host process's native path flavor, preserving Windows
drive-relative behavior; if no project directory is available, the guard
conservatively passes the path through. Disable with
`disabled_hooks: ["search-path-guard"]` (see [Hooks](configuration.md#hooks)).

---

## Background Task Control

| Tool | Description |
|------|-------------|
| `task_status` | Read a child's state and latest result; on V1 managed also resolves aliases and `diagnostic: true` excerpts |
| `task_report` | (V2 native) Send a bounded progress update or blocker from a running subagent to its owning parent; queue-only |
| `task_message` | Queue a bounded instruction into a running child's context without starting a new run (V1 managed only; on V2 steer with `subagent(sessionID, prompt)`) |
| `task_reply` | Answer a child's pending control request by exact session ID and request ID. On V2 it is a permission-only host bridge; answer questions in the host UI |
| `task_cancel` | Ask the host to interrupt the child's active execution while retaining its session |
| `task_revive` | Resume a retained session with a new instruction (V1 managed only; on V2 continue with `subagent(sessionID, prompt)`) |
| `wait_for_user` | Pause automatic orchestrator wake prompts until the next distinct external user message (V1 managed only; not registered on V2 — use the native `question` tool there) |

`backgroundJobs.mode: "native"` is the V2 default. It leaves child execution,
continuation, completion delivery, and restart recovery to the host and
registers a thin control surface instead of the board-backed one:
`task_status`, `task_cancel`, and `task_reply` on the parent, plus the
child-only `task_report`. They take an exact child session ID (the V2
`sessionID` parameter; V1 native uses `task_id`), verify `parentID` with a
bounded host read, and expose no aliases, history reconstruction, adoption,
diagnostics, or board state. `mode: "off"` registers no OMOS task tool at all.

`task_status` reports what the host round and trailing transcript prove. On V2
that evidence is reconstructed from the child transcript, so an unfinished round
is `unconfirmed` rather than a live status claim. It also lists pending
permission requests for that exact child, bounded, when the host exposes
`permission.list`; a host without the capability reports `unavailable` instead
of inventing an empty list. This is an on-demand pull after a missing notice,
not a poll loop. `task_cancel` sends the host's own interrupt without a status
pre-check: it is a no-op for an idle session, reports whether the host reported
interruption, and leaves cleanup plus the terminal notification to the host. The
session is never deleted and stays continuable.

On V2 native, a child can use `task_report` for a material milestone,
consequential finding, blocker, or decision request. The recipient is always
read from the child session's host-owned `parentID`; callers cannot choose
another session. Reports enter the host's serialized inbox with
`delivery: "queue"` and `resume: false`: the tool confirms that the host queued
the report, not that the parent read it, started a turn, or woke. The parent can
reply by continuing the same child session with the native V2
`subagent(sessionID, prompt)` tool.

On V1 managed, the task controls use the task ID or its parent-scoped alias for
the task being managed. `task_status` with an unknown or placeholder ID enumerates the
session's recent task handles, including recently finished sessions, so a
handle lost to compaction is recoverable from the error itself. `task_cancel`
stops the generation but retains its session; it does not roll back partial edits.
After cancelling a write-capable task, inspect and reconcile file changes before
launching replacement work.

On V1 managed, `task_cancel` and `task_revive` admit managed parent sessions, including Build
and custom primary agents that have delegated work. Host tool permissions still
apply, and a parent can only control its own children. Switching primary agents
does not transfer child ownership. Completed results are surfaced and
acknowledged for reuse regardless of the parent's agent name.
History recovery and injected completion handling use the same managed-session
admission; an unmanaged Build turn is not promoted to Orchestrator.
This does not add the Orchestrator prompt to Build or make it delegate automatically.

If the abort request times out while still pending, `task_cancel` reports
uncertainty and retains its cancellation lease: a late abort must not affect a
reused session. There is no lease TTL; an abort that never settles keeps reuse
blocked. Late settlement releases the token but does not resume verification or
publish confirmed cancellation; recovery depends on subsequent observation.
`task_message` (v1 only) does not interrupt the current generation. It retains
its per-task message lease when the local timeout expires but the write
transport is still pending. `noReply: true` prevents starting a turn, not
mutating the transcript: a delayed update, including its captured
agent/model/variant, could otherwise alter the context of a reused generation.
A timeout does not prove that the message was not delivered.

Until the write settles, the lease excludes further messages, cancellation via
`task_cancel`, same-session revival/reuse, and lease-protected terminal
notifications for that taskID. If the write never settles, this control-plane
exclusion persists indefinitely; no automatic recovery is promised. It does not
stop the child from executing or block other taskIDs, and results can still arrive
through other observation/result paths. Settlement, whether success or failure,
releases the token. There is no TTL or `session.abort` rollback for this write.

This is local exclusion among operations following the board's lease protocol,
not isolation from external actions or an exactly-once delivery guarantee.
Removing a job with `board.drop` or `clearParent` does not retire its lease:
`liveLeases` is independent of `jobs`, so deleting the record does not guarantee
recovery of the taskID's exclusion. The model-identity lookup is a separate read:
its timeout signals cancellation of the lookup and releases the lease even if that read never
settles, because no message write has started.

`task_message` pins the newest valid user or assistant model/variant in the
bounded transcript, skipping compaction summaries; the session's saved
selection can predate a hook rewrite. No valid identity means no message is
sent. The write sends a real, non-synthetic `noReply` prompt in the same child
session: no wake, no new run, no interrupt, and no agent/model/variant switch.
The host assigns the message id; the plugin records the id the host returns
as the generation's amendment boundary (a response without one records no
boundary). Queue consumption is not confirmed:
`Message queued for … without launching or resuming it.`

A success response confirms only transport acceptance, not consumption: the host
admitted the input, with no proof the child read it. Consumption timing is
host-dependent; a single step's multiple
tool calls are not individually interleavable. Host errors are not retried
with weaker semantics.

`task_revive` resumes a retained session with a new instruction. A cancelled,
errored, or stopped retained session may be revived immediately once its
retained state has been verified safe. Acknowledgement controls parent and
job-board consumption and reusable-pool display, not same-session revival.
On v1 a confirmed parent fallback routes that child's next prompt, like a
`task_id` resume; with explicit model inheritance it follows the parent's live
model, whether selected by fallback or a manual change. A failed send may leave
the v1 intention pending until claimed or evicted by the
bounded FIFO.
For existing tracked sessions, baseline capture has a 5-second deadline: expiry fails without sending a prompt
and releases the relaunch lease. The local admission wait has a 10-second deadline;
expiry returns `status: admission_unknown`, not a launch failure. The reported
generation/state is the pre-admission snapshot, even if acceptance settles before
the caller receives the deadline result. The host may already be running
the prompt, so do not retry: inspect with `task_status`. The pending send retains
its lease until settlement; late acceptance registers the new generation once,
while rejection releases it without registration. Completion probing happens
after lease release, and probe errors are logged as observation failures.
Observation does not reserve the generation: if another `task_revive` replaces it
while the first caller awaits its probe, the first call rejects with
`revive became stale`. This supersession rejection does not invalidate the newer
launch; use `task_status` to inspect the current generation.

Deletion wins over pending admission: deleting the child or its parent never
recreates either record when acceptance arrives. If the original relaunch lease
still owns the missing child, existing tracked revival uses a separate compensation owner to send exactly one
abort for that child, without registering a generation, clearing its tombstone,
notifying the deleted parent, or aborting siblings. A revoked/replaced lease or
changed generation remains fenced and never triggers an abort of its successor.
If the caller is still waiting, it receives `admission accepted but invalidated by
loss of the record; compensation initiated`; an already-returned
`admission_unknown` is unchanged. Admission rejection needs no compensation.
The compensation retains exclusion while abort is pending, without a local
deadline releasing it. Only actual abort settlement followed by a fresh, bounded
live-status read confirming idle/absence releases that exact lease. An abort
failure or unverifiable/busy status logs `compensation unconfirmed` and keeps the
ID excluded indefinitely: no automatic retry or recovery. Historical outcomes
are not stop evidence; live quiescence does not guarantee queued prompts were
purged, so future queued execution remains uncertain even after lease release.

The V1 delegation tool (`task()`) refuses an explicit `task_id` it cannot
resume instead of dropping it and spawning another session. An id the local
board does not know is not a cue to omit `task_id` and start another session;
call `task_revive` with that same id directly. A failed lookup keeps the id and
does not start another child; it verifies the original host session and
continues there. A `task_status` result read only retrieves a finished result
and is not required before that continuation.

On V2, `subagent()` is the host's native tool: an explicit `sessionID` is
resolved by the host, and a rejected id comes back as a readable host refusal.
The plugin does not import, alias, or adopt the session. A completed, errored,
interrupted, or stopped session continues with `subagent(sessionID, prompt)`;
`task_revive` is not registered on V2.

On V1 managed, a successful native delegation result may end with a
`slim-child-ref:v1` marker so a later restart can resolve the alias. The marker
is trusted only on the parent's real native tool result, after the outer task
closes — or, for a native background plaintext launch result with no closing
tag, only when the marker is that output's final non-empty line — and only when
it matches that result's session ID and original agent argument. A numbered
alias is issued only to children of a parent created while the plugin instance
runs (see [Background Orchestration](background-orchestration.md)); any other
new task is still created and is referred to by its exact session ID.

`task_status` reports `last_activity_source` alongside tracked activity time:
`observed-activity` means a tracker event (completed assistant/step or host
busy/retry), which may lag the host; `host-busy` is a coarse busy observation
beyond the run start, not proof of useful work; `launch-time` means no activity
evidence beyond the run start time, not proof the child did nothing; `unknown`
means no activity evidence is available. Tracker entries are session-keyed, so
a pre-revive entry can supply an older timestamp; timestamps are unchanged.

Use `diagnostic: true` only for tracked, finished-but-unsuccessful children:
error, cancelled, or stopped. It returns a labelled, non-final tail excerpt,
including short assistant errors and failed-tool error text, never tool inputs or
successful tool outputs. Host compaction triggers and summaries are excluded
and counted as omitted messages. The terminal reason uses a recorded host
error/outcome reason, then attributable assistant error text, then the state
name—not partial findings from the stored result summary.
The tool's rendered diagnostic response is capped at 6,144 UTF-8 bytes,
including headers, errors, and truncation markers; plugin
warnings may be appended separately. The fetch requests the newest 100 messages.
Our own scanning is bounded to 40 trailing messages, 100 trailing parts per
message, and 2,000 excerpt characters per message. A v1 host may ignore the
limit; the excerpt scan still stays bounded. Attribution outside the scan window
is reported as uncertain or unavailable, not guessed. Truncation and unavailable
evidence are explicit.
Running children are refused; completed
children point to `result: true`. The two modes are mutually exclusive.

### Diagnostic attribution

Attribution is identity-fenced where the host surfaces admitted input ids:
a tracked run records the admission id of its opening input (native launch,
resumed call, or queued revive). The excerpt must sit behind an input
recorded for this generation — the opening input, or a same-generation
amendment the plugin itself delivered (a v1 `task_message` deposit, or a v2
steer whose host execution provably admitted it). Both amendment channels
capture the run's publication identity (generation + terminal revision) and
commit only while that exact run still owns the row: still running at the
captured revision, or its single terminal publication (`captured + 1`,
which may land before the deposit's response or the steer's outcome commits).
A deposit the host accepts only after the caller's deadline still records its
boundary; the tool's own return stays a timeout rejection. A reopened or
replaced run refuses. Any other later input — including the
host-finish-to-publication gap — refuses with a stated reason instead of
misattributing; an anchor outside the bounded window also refuses.
An anchored excerpt keeps every assistant message after that recorded input
in transcript order, even when it predates the generation's registration: a
resumed foreground child can finish before the plugin registers its run.

Runs without a recorded input id (older rows, hosts that surface no
admission id) keep the timestamp fence: the excerpt starts after the latest
real input in the window and excludes assistant messages created before the
recorded run start. Those reads are labelled by the `evidence` line, never
claimed as identity-attributed. Input may predate registration; late
registration can omit genuine early output. A missing input boundary,
missing assistant creation times, or only pre-start evidence makes an
unanchored excerpt unavailable.

Real input or assistant activity created after the recorded completion time
returns `evidence: unavailable`. So do records without a completion time and
legacy records whose recorded time predates their final assistant message.
Compaction and system maintenance do not count as new run activity. For
anchored runs the publication gap is closed by the identity fence: a new
input that reaches the child before the old outcome is published makes the
recorded anchor no longer the latest input, so the read refuses — unless the
input is the recorded amendment, which is exactly what keeps an
amended-but-failed generation readable. Unanchored runs retain the
documented timing gap.

An owned untracked handle returns the ordinary read-only status plus a short
notice that diagnostics require a tracked task record, not an excerpt or an
extra transcript read. Startup recovery normally re-adopts restarted children
onto the board with their historical run start. Foreign-parent handles are
still rejected.
Diagnostics are read-only, not consumption or acknowledgement: observed state
is evidence, execution completion ends a run, and parent acceptance is a
separate decision. Diagnostic reads do not reconcile or resume a child.
The fixed next-step line reminds callers to treat the excerpt as non-final
evidence and await or re-delegate, not mark the task accepted.

On V1 managed, `task_status`, `task_message`, `task_reply`, `task_cancel`,
`task_revive`, and an explicit resume ID resolve a non-exact alias from the
tracked job records first, else from the markers in one read of the parent's
readable history, before reading or sending anything. The read covers the 1,000
most recent messages; a longer history counts as cut. Multiple saved targets, no
marked target, or a cut or unreadable history produce no action: use the exact
session ID. Exact IDs do not require alias-history scans. On V2 native, every
control takes the exact session ID; there are no aliases or history scans.

On v1, `task_revive` retains the upstream exact-ID adoption path only when
no child transcript is available; conflicting or unreadable evidence never
falls back to it. Busy/retry host work is refused, not aborted. An evicted
persisted terminal result is returned on the first revive attempt without
sending a prompt; its suppression tombstone is cleared, not its deletion
epoch. A later attempt can continue that same child.

Revive checks for an idle-verification mechanism before aborting an active child:
the live status map on v1. Missing capability fails before abort, baseline
capture, or prompt; retrying cannot supply that capability.
Waiting is not an instantaneous snapshot: it may wait for a busy child to idle,
and cannot prevent an independent resume after verification. The final board
ownership/activity guard and queued delivery remain in force.

An accepted revive can return `status: started` with `status_uncertain: true` and
an observation diagnostic. A historical or unattributable `session.get` outcome
is not a failure of the new generation. Attribution uses the
admission boundary (not its delayed ACK), the current observation attempt and
the latest live activity. Uncertainty alone never becomes terminal on retry
exhaustion; existing events/probes and independent valid evidence can resolve it,
but there is no guaranteed recovery deadline.

`wait_for_user` is primary-only (the built-in orchestrator and declared
primaries) and v1-only; it is not registered on v2. The orchestrator uses it as the final
tool action after providing concrete instructions for external manual work. Its
`reason` is diagnostic text only; the plugin does not parse assistant prose to
decide whether a turn is HITL. A new real user text/file/image message clears the
wait. Synthetic/internal messages and duplicate delivery of the user message
that preceded the wait do not.

See the background orchestration concepts in
[Background Orchestration](background-orchestration.md) for the session
lifecycle, cancellation, and explicit-wait edge cases behind these tools.

---

## Repeated Tool-Call Loop Guard

A safety net for model-side infinite loops where a sub-agent (e.g. a model
that can degenerate, such as DeepSeek V4 Flash in Explorer) re-issues the
exact same tool call with identical arguments and gets identical results,
making no progress. The plugin watches each session's consecutive identical
tool calls — counting only calls that return results identical to the
previous call, so a call returning new information (e.g. a file that was
modified) never counts toward a block — and responds:

- After the 3rd confirmed-identical result: appends a corrective notice to
  the tool output telling the model to stop repeating and change approach.
  Applies to all tools.
- After the 5th confirmed-identical result: refuses the next identical call
  for the read-only file tools `read`, `grep`, and `glob`, terminating the
  loop. Other tools stay warn-only.

The count is confirmed in `tool.execute.after`, so overlapping parallel
calls cannot inflate it before their results are known.

Exempt from the entire guard: `task`, `task_cancel`, `task_message`, and
`task_revive` — they legitimately re-issue identical calls while a background
task runs. `task_status` is warn-only (never hard-blocked), so a repeated
status read cannot deadlock result retrieval. The wait tools (`wait_for_user`,
`wait_for_background_tasks`) run a stricter per-turn counter of their own: the
second repeat warns, and the guard refuses further repeats in that turn.

Disable with `disabled_hooks: ["tool-loop-guard"]` (see
[Hooks](configuration.md#hooks)).

