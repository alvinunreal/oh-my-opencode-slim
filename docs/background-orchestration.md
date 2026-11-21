# Background Orchestration

Slim is a specialist operating model over **native OpenCode 2.3+ subagents**.
OpenCode owns child execution, continuation, steering, durable Jobs, completion
admission and restart recovery. Slim supplies routing/coordination policy and
optional on-demand controls, not another job ledger.

## Lifecycle modes

`backgroundJobs.mode` selects Slim's tool surface. Both values leave native
subagents available:

| Mode | Slim controls | Session-preset routing default |
|---|---|---|
| `native` (default) | `task_status`, `task_cancel`, `task_reply`, child `task_report` | Enabled |
| `off` | None | Disabled |

`sessionPresetRouting` independently selects session-only inference snapshots.
With routing off, the native executor is unwrapped and uses registered agent
configuration; the startup `preset` still selects that configuration. Council
seat assembly and Observer do not depend on task controls or session routing.
See [Configuration](configuration.md#minimal-setup) for a minimal setup.

There is no Slim reusable-session pool, short alias authority, board injection,
wall-clock watchdog, concurrency queue or periodic idle TODO wake. Removed
settings do not configure native equivalents. See
[Upgrading](installation.md#upgrading) before loading this source on an older
host/configuration.

## Coordination policy

The Orchestrator plans, delegates, reconciles and verifies. It can do small,
clear work directly when it already has the context. Context-heavy documentation
and summaries stay with the owner holding that context instead of forcing a new
specialist to rediscover it.

For delegated work:

1. Identify dependencies and the final evidence needed. Use only enough planning
   to avoid wasted work and conflicting edits.
2. Dispatch independent lanes in parallel. Each writer owns a disjoint scope;
   review the state a reviewer is actually being asked to assess.
3. Make each brief self-contained: goal, constraints, paths/lines, allowed edits,
   validation owner and expected evidence. Preserve a user-directed specialist
   request verbatim, separate from the caller's interpretation.
4. Keep each returned session ID and continue only independent work. Submission
   is not completion; use native completion delivery rather than polling.
5. Inspect results/artifacts against the request. Missing scope and out-of-scope
   changes are defects. Continue the same child for repairs rather than create a
   fresh lane to reload its context.
6. Reconcile every writer before final checks. Lanes run focused checks; final
   verification runs once at the settled state, proportionate to risk. Require
   commands, exit statuses, evidence and explicit skips; revalidate after edits.

Oracle and Council reviews are for material risk, unresolved uncertainty or
high-cost judgment, not an automatic extra lane on every task. Role-specific
routing lives in the agent prompts; [Council](council.md) describes independent
seat synthesis.

## Native completion and continuation

The native `subagent` tool returns immediately and reports each settled child
period. Its `sessionID` continues the same child, whether running or settled.
The host also reports later direct child prompts, not only calls through the
subagent tool. A busy parent receives a steer at its next step boundary; an idle
parent can receive a successor turn.

A returned ID or accepted report is not proof that work finished or that the
parent consumed the output. Treat specialist summaries as claims and verify the
produced artifacts. Slim adds no duplicate completion message.

[Tools](tools.md#background-task-control) owns the argument and result contracts
for optional controls. Their ownership is narrower than native APIs:

- Status is an exact owned-child read after a missing result, not a poll loop;
  missing or ambiguous evidence stays `unknown`.
- Cancellation asks native interruption while retaining the session. Acceptance
  is not confirmed cleanup, rollback or deletion; an idle interrupt is a no-op.
- Parent replies answer **permissions**, not V2 question forms. Questions use
  the host UI; child question tools are denied by default unless configured.
- A child report is a bounded material milestone/blocker admitted to its owning
  parent's native inbox. It requests a wake unless that parent was interrupted;
  acceptance does not confirm processing.

## Task-fit rejections

A specialist receiving work outside its role returns a brief reason instead of
attempting partial implementation. The Orchestrator reroutes or clarifies the
request; it does not resend the same unchanged work to that specialist.

Coordination needs only the facts supporting the request: child ID, specialist,
objective, write scope, dependencies and result. These belong to the task brief
and conversation, not a second plugin-side state machine.

## Cancellation, restart and uncertainty

OpenCode owns cleanup and terminal publication. Cancellation does not undo
partial edits. If a transport read or interruption request times out, it may
still land; retain that uncertainty instead of manufacturing a terminal state.

The native recovery sweep can resume running Jobs and deliver pending outbox
reports. It is **at-least-once**, not exactly-once for external effects. A saved
Job is not proof that recovery ran, and an embedding that does not run the sweep
gets no substitute from Slim. Do not blindly repeat an uncertain continuation.

Slim does not import old board records into Jobs or write a V2 tombstone/delivery
ledger. Native reload cancels pending permissions/forms; continued work may need
to ask again. When a result cannot be established, report the missing evidence.

## Verification

The end-to-end result is accepted only after relevant lanes are settled,
reconciled and supported by final-state evidence. Tool submission, a status read
and a host completion event each prove different things; none proves output
quality by itself.

`scripts/verify-v2-native-lifecycle.ts` exercises the packed plugin against its
specified real host with a mock provider, including off-mode Council/Observer.
That validates routing and request construction, not external model quality or
all restart race windows. Cache properties and optional-loading checks cover the
separate invariants described in [Runtime Efficiency](runtime-efficiency.md)
and [Cache Verification](cache-verification.md).
