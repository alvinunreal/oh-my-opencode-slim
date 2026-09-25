# Tools & Capabilities

Built-in tools available to agents beyond the standard file and shell operations.

## Agent Marketplace

The Orchestrator can call `marketplace` with an `action` and action-specific
fields; specialist sessions cannot use it. `install` and `update` take a
`packageId` such as `publisher/package`; `import` takes a local `path` and
optional `update: true`. `enable`, `disable`, `remove`, and `show` also take
`packageId`. `list` and `status` take only `action`; `verify` optionally takes
`packageId`. Do not pass a filesystem path to `install` or a registry ID to
`import`.

```json
{ "action": "install", "packageId": "publisher/package" }
```

`install` through the tool stores the package but **does not enable it**; call
`enable` separately. In-session mutations do not restart the OpenCode service
or hot-swap registered agents. `status` reports installed/configured/live
state and `reload_status` (`applied`, `pending`, or `unavailable` when the
comparison cannot be made). Reload or start a new session for changes to take
effect. `list`, `show`, `verify`, and `status` do not fetch from the registry;
only explicit `install`/`update` do. See [Agent Marketplace](marketplace.md)
for the CLI's different install/restart behavior and complete lifecycle.

---

## apply_patch rescue

Slim only intercepts `apply_patch` before the native tool runs. It rewrites recoverable stale patches, canonizes safe tolerant matches against the real file when unicode/trim drift is the only mismatch, keeps the authored `new_lines` bytes intact, preserves the existing file EOL/final-newline state for updates, validates malformed patches strictly before helper execution, uses a conservative bounded LCS fallback, accumulates helper state when the same path appears in multiple `Update File` hunks, blocks `apply_patch` before native execution if any patch path falls outside the allowed root/worktree, and fails on ambiguity instead of guessing. It does not rewrite `edit` or `write` inputs.

---

## Web Fetch

Enhanced version of OpenCode's built-in `webfetch`. Overrides the default when
this plugin is active. Fetch remote pages with content extraction tuned for
docs/static sites.

| Tool | Description |
|------|-------------|
| `webfetch` | Fetch a URL, optionally prefer `llms.txt`, extract main content from HTML, include metadata, optionally save binary responses, and optionally run secondary-model extraction |

See the full [Webfetch documentation](webfetch.md) for parameters, output
format, caching, llms.txt probing, redirect policy, secondary-model
summarization, binary detection, and implementation details.

`webfetch` blocks cross-origin redirects unless the requested URL or derived permission patterns explicitly allow them, and it can fall back to the raw fetched content when secondary-model summarization is unavailable.

---

## Code Search Tools

Fast, structural code search and refactoring - more powerful than plain text grep.

| Tool | Description |
|------|-------------|
| `grep` | Fast content search using ripgrep |
| `ast_grep_search` | AST-aware code pattern matching across 25 languages |
| `ast_grep_replace` | AST-aware code refactoring with dry-run support |

`ast_grep` understands code structure, so it can find patterns like "all arrow functions that return a JSX element" rather than relying on exact text matching.

Before the built-in `grep`/`glob` tools run, the plugin pre-checks that the
requested `path` is valid, using the same resolution rules as the host:
v1 `grep` joins relative paths, while v1 `glob` resolves them; v2 resolves
relative paths for both tools. Missing paths and paths with a non-directory
component fail fast with an actionable error instead of an opaque "ripgrep
execution failed" message or a silent search of the parent directory.
Resolution uses the host process's native path flavor, preserving Windows
drive-relative behavior; if no project directory is available, the guard
conservatively passes the path through.

---

## Background Task Control

| Tool | Description |
|------|-------------|
| `task` | Start a specialist task and return its task ID |
| `task_status` | Check the status of a task |
| `task_result` | Retrieve a task's result |
| `task_message` | Queue a non-interrupting message and return `queued` |
| `task_cancel` | Stop a generation while retaining its session |
| `task_revive` | Resume a retained session with a new instruction |
| `wait_for_user` | Pause automatic orchestrator wake prompts until the next distinct external user message |

The task controls use the task ID or Background Job Board alias for the task being
managed. `task_message` does not interrupt the current generation. `task_cancel`
stops the generation but retains its session; it does not roll back partial edits.
After cancelling a write-capable task, inspect and reconcile file changes before
launching replacement work.

If the abort request times out while still pending, `task_cancel` reports
uncertainty and retains its cancellation lease: a late abort must not affect a
reused session. There is no lease TTL; an abort that never settles keeps reuse
blocked. Late settlement releases the token but does not resume verification or
publish confirmed cancellation; recovery depends on subsequent observation.
After abort settles, verification has its own time budget. The v2 session-info
read uses only the remaining budget: timeout leaves the task uncertain and
releases the lease without confirming cancellation or consuming late evidence.

`task_message` retains its per-task message lease when the local timeout expires
but the write transport is still pending. `noReply: true` prevents starting a
turn, not mutating the transcript: a delayed update, including its captured
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

On v2, `task_message` inherits the session's persisted agent/model/variant instead
of reading and pinning selection per call; v1 retains its authoritative lookup.
The v2 write uses `delivery: "queue", resume: false`: it updates the transcript
without scheduling execution, never via a synthetic message or selection switch.
Host errors are not retried with weaker semantics. A pending write still retains
its message lease after timeout; this change does not alter that quarantine.

`task_revive` resumes a retained session with a new instruction. A cancelled,
errored, or stopped retained session may be revived immediately once its
retained state has been verified safe. Acknowledgement controls parent and
job-board consumption and reusable-pool display, not same-session revival.
Baseline capture has a 5-second deadline: expiry fails without sending a prompt
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
still owns the missing child, a separate compensation owner sends exactly one
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

`task()` refuses an explicit `task_id` it cannot resume instead of dropping it
and spawning another session.

Revive checks for an idle-verification mechanism before aborting an active child:
the live status map on v1, or the host's idle wait on v2. Missing capability fails
before abort, baseline capture, or prompt; retrying cannot supply that capability.
The v2 wait has a 5-second local budget. Timeout, rejection, invalid completion,
or completion processed after the deadline sends no prompt and releases the
preparation lease. A late settlement does not resume the finished revive flow.
Waiting is not an instantaneous snapshot: it may wait for a busy child to idle,
and cannot prevent an independent resume after verification. The final board
ownership/activity guard and queued delivery remain in force.

An accepted revive can return `status: started` with `status_uncertain: true` and
an observation diagnostic. A historical or unattributable `session.get` outcome
is not a failure of the new generation, on either v1 or v2. Attribution uses the
admission boundary (not its delayed ACK), the current observation attempt and
the latest live activity. Uncertainty alone never becomes terminal on retry
exhaustion; existing events/probes and independent valid evidence can resolve it,
but there is no guaranteed recovery deadline.

`wait_for_user` is also orchestrator-only. The orchestrator uses it as the final
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

Exempt from the entire guard: the task-control and wait tools (`task`,
`task_status`, `task_result`, `task_cancel`, `task_message`, `task_revive`,
`wait_for_user`, `wait_for_background_tasks`) — those legitimately re-issue
identical calls while polling a long-running background task.

---

## Formatters

OpenCode automatically formats files after they are written or edited, using language-specific formatters. No manual step needed.

Includes Prettier, Biome, `gofmt`, `rustfmt`, `ruff`, and 20+ others.

> See the [official OpenCode docs](https://opencode.ai/docs/formatters/#built-in) for the complete list.

---
