# src/hooks/orchestrator-wake/

## Responsibility

Periodic orchestrator wake scheduler. After continuous parent-idle time,
capability-gated host session APIs may receive a static internal wake prompt
when incomplete todos remain (or when a background job stopped without a
terminal result). Normal child progress is silent; stable child evidence keeps
a bounded stalled-child check. Host responses are authoritative and the local
job board is never consulted. Progress/reservation state is process-global so
independently created hook instances share one-flight and the two-wake
no-progress cap.

On v2 hosts (hostFlavor 'v2' from the client shim) the plugin creates NO wake
scheduler at all (council 2026-10-23): the host's native background notifier
owns terminal delivery — steer reaches a busy parent at its next step
boundary, restart recovery re-delivers from the durable KV job marker, and
the durable inbox dedupes by message ID — and child permission/question asks
are a host-UI boundary the host does not route to the parent agent. Every
`orchestratorWake` config key is v1-only and warns as ignored on v2; asks
stay discoverable via `task_status` pull. The v1 code path is unchanged.

## Design

- **Scheduler** (`index.ts`): `createOrchestratorWakeScheduler(ctx, options)`
  returns `{ event, observeChatMessage, triggerStoppedJobRecovery, triggerCompletedJobPublication, suppress }`.
  - Tracks per-session local state (`generation` symbol, timer, continuous
    idle flag, and archive suppression) only; progress lives in the process
    gate.
  - Capability record (`probeSessionApis`): v1 requires the historical
    probe set (get/todo/children/status/promptAsync). `resolveWakeMode` maps
    the configured mode to todo/children.
  - Gates (`scheduleBlocker`): config enabled, capability gate ready, managed
    session, no input wait (`hasInputWait`), no fallback in progress, gate
    not stopped. Reports a reason when blocked, deduplicated per session/reason
    within one idle spell; ending the spell or arming a timer resets that
    deduplication so later blocks remain visible. Forced recovery and
    child-input blockers log their trigger separately from the periodic
    `backstop not armed` payload; blocked publications log task identity.
    Logs when the backstop is armed or halted and when evaluation
    aborts/defers at a checkpoint.
  - Reads a host snapshot (todo mode: todos + children + status map +
    session model/archive state; children mode: children list + event-tracked
    parent status + optional model/archive state) and computes a fingerprint; unchanged
    fingerprints across wake attempts hit `ORCHESTRATOR_WAKE_UNCHANGED_CAP`
    (2) and stop.
  - Checkpoint classification (`classifyTodoSnapshot` /
    `classifyChildrenSnapshot` → `applySnapshotVerdict`): identical v1
    check order (parent-active → active-child suppression → todo
    condition); children mode uses the event-tracked parent race guard
    (fail-open) and freshness-based child activity, then defers periodic wakes
    whenever the child fingerprint is not stable — first baseline
    observation and normal progress alike. Stable fingerprints retain the
    bounded
    stalled-child check; forced publication/recovery wakes bypass it.
  - Event bookkeeping: `lastStatusBySession` (busy-set + race guard),
    `childSessions`/`childEvidence` from `session.created` parentID links
    (v1 event shape), all bounded at 512 entries FIFO and
    cleared on `session.deleted`/dispose. `session.updated` archive state
    suppresses or restores the local session timer/generation.
  - Wakes via `promptAsync` with a static `<system-reminder>` text
    (`ORCHESTRATOR_WAKE_TEXT`, `ORCHESTRATOR_CHILDREN_WAKE_TEXT`, or
    `ORCHESTRATOR_STOPPED_JOB_WAKE_TEXT`), reserving before the send and
    rolling back cap accounting on failed delivery without waking waiters.
    #1411: a delta-less wake whose body was already delivered in the session
    sends a short non-identical repeat marker instead (`WAKE_REPEAT_CORES` +
    `wakeRepeatMarker`; child-input wakes exempt, delta-bearing wakes keep
    the full template) and logs `duplicate wake body suppressed`.
    Retries follow the interval timer; failed publication/recovery retains its
    reason until delivery or a generation change. Pending publication facts
    restore the publication reason after parent busy transitions, even when
    periodic wakes are disabled; deletion still discards them.
  - A delivered publication consumes the per-parent throttle inside
    `evaluate`, whether delivered directly, by timer or by one-flight
    waiter. Failed/vetoed attempts and periodic deliveries do not consume
    it; `waking` with task identity is logged only by the direct trigger.
  - `triggerStoppedJobRecovery`: immediate recovery wake for jobs that stopped
    without a native terminal result (separate from the periodic TODO wake;
    bypasses the wake condition, as on v1). Queued facts are revalidated by
    task ID + generation before delivery; the bounded detail queue emits an
    overflow signal instead of silently losing excess recovery state.
  - `triggerCompletedJobPublication`: one-shot push for a LATER terminal
    publication (rev>1) that the host's native first-publication notifier
    does not cover. It rides the same bounded delta queue as the stopped-job
    recovery (cap `COMPLETED_JOB_QUEUE_CAP`, `COMPLETED_JOB_WAKE_CHUNK` per
    wake, overflow pointer to `task_status`) instead of the terminal-
    publication wake, which drops on a busy parent and on the per-parent
    throttle. The delta body is `<completed-job>` (alias, task, state,
    result); the run fence (task, generation, terminal revision) rides the
    delivered part's metadata, never the prompt body, so parent-history
    observation retires exactly that run.
  - `triggerChildInputWaitWake`: coalesces asks for 250 ms before evaluation so
    host/UI auto-replies can settle first. Resolved asks are pruned; empty
    batches cancel their timers. Duplicate asks retain the original deadline.
    Stopped-job wakes stay immediate and do not carry still-settling asks.
    Settling is rechecked after awaited reads/selection before reserving a
    child-only wake, so a concurrent ask cannot produce a false stop notice.
    Retained overflow keys are revalidated along with inline asks, and
    overflow-only wakes use the input template plus bounded task IDs.
    Identity-based retirement preserves new overflow added during delivery.
    Parent deletion, archive/suppression and instance disposal clear timers.
  - `observeChatMessage`: real external user activity rearms the no-progress
    cap and records the observed model for continuation prompts.
- **Delta queues**: one shared bounded-queue shape (`makeDeltaQueue`) backs
  the stopped-job recovery, the completed-job push, and the child-input
  ask. Per-kind policy (cap, chunk, blocker trigger, actionability
  predicate) is construction-time only.
- **Gate** (`wake-gate.ts`): Process-local reservation/progress store shared
  via `globalThis` + `Symbol.for` (`oh-my-opencode-slim.orchestrator-wake-gate`):
  - `tryBeginWakeEvaluation` / `releaseWakeEvaluation` / `retryAfterWakeEvaluation`:
    single in-flight evaluation per session with waiter re-queueing.
  - `commitWakeReservation`: marks a committed wake and sets `expectingWakeBusy`
    so the next busy preserves (not rearms) the no-progress cap.
  - `rollbackWakeReservation`: owner-guarded failed-send accounting rollback;
    leaves the committed marker intact to avoid immediate waiter retries.
  - `noteHostProgress` / `rearmWakeProgress`: fingerprint-unchanged counting
    and external-activity resets.
  - `getObservedWakeModel` / `setObservedWakeModel`: last-seen model for
    continuation prompts.
  - #1411: `reserveWakeBodyOccurrence` tracks per-session delivered
    delta-less wake bodies with occurrence counts and bumps
    `suppressedDuplicateWakes` on repeats (`getSuppressedDuplicateWakes`
    reads it). `rollbackWakeBodyOccurrence` undoes a failed send's
    reservation so the retry delivers the full text instead of a phantom
    repeat. `getStore()` backfills the two maps so a store object left by a
    pre-#1411 in-process reload cannot crash the delta-less path.
  - Bounded at `MAX_TRACKED_SESSIONS` (256) with insertion-ordered eviction.

## Flow

```
session.idle / session.status(idle)
    ↓
beginContinuousIdle() → arm interval timer
    ↓
evaluate() (one-flight via gate)
    ├─ read host snapshot (todo mode: todo/children/status;
    │  children mode: list/event-tracked children + parent status)
    ├─ active status? → end idle spell
    ├─ todo mode: active child? → schedule later; no incomplete todos? → end
    ├─ children mode: no fresh child activity? → end
    ├─ children mode: fingerprint not seen before? → record baseline, defer
    ├─ children mode: changing fingerprint? → defer to next interval
    ├─ stable fingerprint → bounded stalled-child wake, then cap
    ├─ fingerprint unchanged ≥ cap? → stop
    ├─ recheck archive state immediately before promptAsync
    ├─ commitWakeReservation
    └─ promptAsync(internal wake reminder)
       └─ on failure, roll back cap and retry on timer with original reason
    ↓
busy (wake-initiated) → endIdleSpell(rearm=false)   [cap survives]
busy (external) / errors / user activity → rearm cap
```

## Integration

- **Consumer**: `src/index.ts` creates the scheduler on v1 and routes `event`,
  `chat.message` (`observeChatMessage`), `wait_for_user` (`suppress`), and
  job-stopped recovery triggers to it; config comes from
  `runtime.backgroundJobs.orchestratorWake`
  (`{ enabled, intervalMs, mode }`).
- **Task-session-manager seams**: `hasInputWait` (input-wait-tracker) and
  `parseContinuationModelSelection` (continuation-model-selection) gate and
  parameterize wake prompts.
- **SessionLifecycle**: registers `session.deleted` cleanup via the
  coordinator.
- **Dependencies**: `createInternalAgentTextPart` /
  `isInternalInitiatorPart` (`src/utils/internal-initiator.ts`), `log`,
  `isRecord`, `SessionLifecycle`, and the task-session-manager status/selection
  helpers.
- **Foreground-fallback**: `isFallbackInProgress` suppresses scheduling during
  fallback cycles.

## Error Handling

- SDK failures during evaluation roll back the failed reservation's cap
  accounting, clear the expecting-busy marker, and log the trigger and
  serialized error (including the name of empty-message errors); the timer
  re-arms via the finally block. An empty children-mode listing falls back
  to event tracking.
- Archived sessions clear their timer and generation on `session.updated`.
- `server.instance.disposed` clears timers, releases owners, and drops pending
  recovery + event-tracking state.
- Model enrichment from `session.get` is fail-soft.

## Performance Considerations

- One unref'd timer per continuously-idle managed session; timers are cleared
  on any busy/error/wait/deletion.
- All process-global state is bounded and evicted LRU-style; event-tracking
  maps are bounded at 512 entries FIFO.
- Host snapshot reads are `Promise.all`-parallel and only happen inside the
  one-flight evaluation.
