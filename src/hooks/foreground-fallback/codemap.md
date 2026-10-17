# src/hooks/foreground-fallback/

## Responsibility
Runtime model fallback system for foreground (interactive) agent sessions. When OpenCode emits rate-limit signals via `message.updated`, `session.error`, or `session.status` events, this manager:
- Detects retryable conditions using pattern matching against error messages and status codes (rate limits, 429, 403/Forbidden, 401/410 failover errors, model unavailable, variant unavailable)
- On v1, withholds `session.abort(X)` while the background job board reports running children of X: held retry events do not seal dedup, exhausted chains still stop intervening, and busy replay errors withdraw any armed handoff when the abort is withheld (explicit refusal admits nothing), and settle it only after a failed abort with unknown outcome. v2 and v1 sessions without running children retain their abort behavior. `session.error` and `message.updated` can re-prompt directly without abort.
- Retrieves the last user message from the session history
- Re-prompts with the first eligible entry from the chain head, skipping tried models and providers abandoned by this session or its parent
- Operates reactively through the event system (cannot wrap `prompt()` directly for interactive sessions)
- Defers terminal job-board bookkeeping for recoverable child failover errors (cooperates with task-session-manager's `willAttemptFallback`). The deferral fences every terminal gate path before replay preparation starts; idle always uses the bounded backstop.

## Design

### Core Abstraction
- **ForegroundFallbackManager**: Class instantiated at plugin initialization; process-local fallback progress is shared across replacement instances
- Maintains per-session state tracking:
  - `sessionModel`: Maps sessionID → current model string ("providerID/modelID")
  - `activeFallback`: Maps sessionID → `{ model, downProviders }` from a
    confirmed switch. `commitSwitch` copies the previous set, adds the failed
    source provider only for provider-scoped failures and removes the target
    provider, including same-provider and sticky switches. Synthetic admissions
    cannot overwrite it implicitly. Continuations and external turns retain it
    when their model is unknown or matches: v1 normally returns to the primary, while
    v2's persistent switch keeps the record live across turns.
    OpenCode v1 internal continuation and lifecycle selection consults
    `fallback.continuationPolicy`: retry the primary by default or retain this
    confirmed fallback for an internal continuation.
  - `sessionAgent`: Maps sessionID → agent name
  - `sessionTried`: Maps sessionID → Set of models already attempted in the descent; earlier chain entries are not marked tried implicitly, and the sticky retry retains this set
  - `sessionRetries`: Maps sessionID → absorbed host retry count for the entire descent (not per model)
  - `chainExhaustion`: Maps sessionID → exhaustion stage; stage 2 prevents further aborts without a fresh descent
  - `inProgress`: Process-global Set of sessions with active fallback in flight, shared via `globalThis` + `Symbol.for`
  - `lastTrigger` + turn/model/incident identity: coalesces repeated
    observations of the same failure while allowing distinct failures on the
    same turn and model to advance the chain; a bounded one-shot exact
    error-payload, model, and turn match correlates an id-less `session.error`
    with its adjacent errored `message.updated` in either event order
  - `turnEpoch`: fences fallback work suspended across promotion, abort,
    backoff, transcript reads, and busy-session retry from acting on a newer
    external user turn; each replay reserves and registers its host-valid
    `msg...` ID in the v1 prompt body before submission, so info-only
    notifications remain identifiable when parts arrive later
  - `userEventSequence`: orders asynchronous user-message identity probes so
    an older transcript lookup cannot overwrite newer turn state; known
    internal replay IDs do not advance the sequence; duplicate/stale external
    user-message updates cannot rewind the current model after a fallback
  - `replayMessageIds`: retain exact IDs of internal replay messages; synthetic
    marker checks remain a fallback for delayed part notifications

### Fallback Chain Resolution
- **Agent-specific chains**: Each agent defines an ordered list of fallback models via `modelArrays`, preserving per-entry variants
- **Chain generations**: The published table (`foregroundFallbackChains`) is swapped atomically by registry finalize and every successful v2 profile refresh (`buildChainGeneration`/`publishChainGeneration` in `src/index.ts`); each session pins the generation in effect at registration (`pinSessionChains`, fired by the v2 profile bridge at profile freeze) and finishes its descent against it — a swap mid-descent never changes what counts as untried
- Selection scans from index 0, skipping tried entries and the union of this
  session's and its parent's `activeFallback.downProviders`. Other models on
  the failing provider remain eligible until a confirmed switch leaves it.
- **Chain lookup**: Resolves the correct chain using:
  1. Agent name (primary) → exact match
  2. Current model (fallback) → search all chains for containing model
  3. Merged list (last resort) → preserve insertion order across all agents
- **No cross-agent bleed**: When agent is identified, only that agent's chain is used (prevents re-prompting with wrong agent's models)

### Retryable Error Detection
- **Pattern matching**: rate-limit/quota/outage/401/403/410/421/451 wording, content-policy moderation and OpenCode v1's content-filter finish error, transport codes (`ECONNRESET`, …) and transport messages, model/variant unavailable errors
- **Scope** (`failoverScope`): provider availability, transport, auth and quota failures have provider scope; policy/content-filter rejections and missing/retired models have request scope. The v2 `provider.content-filter` type has request scope regardless of message or HTTP status, including when the host's retry decision is false. Request wording takes precedence over HTTP status, including a policy rejection wrapped in 403. `isFailoverError` accepts either scope.
- **Status-code probe** (`extractStatusCode`): priority order `statusCode` → `data.statusCode` → `cause.statusCode` → `status` → `response.status` → `response.statusCode` → `data.status` → `data.response.status` → `cause.status` → `cause.response.status`. `asHttpStatus` accepts only finite `100–599` codes (number or 3-digit numeric string), so arbitrary numeric fields are never mistaken for a status.
- **Event coverage**: `message.updated` (message metadata error, or `finish: 'content-filter'` before its error is attached), `session.error` (session-level error), `session.status` (`retry` status). The content-filter finish and its later error share message-ID deduplication. On v1, completed error-free `finish: 'unknown'` messages with confirmed tool-free parts preserve retries and chain state while a per-session streak counts distinct IDs, triggering request-scoped abort and replay at three; unreadable parts neither count nor break the streak. A reply read across a confirmed fallback switch belongs to the previous model and does not count against the backup.
- **Retry budget**: Only a failover-worthy host `session.status` retry (or a v2 retry hook with `decision.retry === true`) charges `fallback.maxRetries`. On v1, each genuine external user turn resets the host retry count, including before any model switch; v2 has no per-turn reset. Terminal `session.error` and errored `message.updated` advance immediately. Exhausting the retry budget keeps it charged across the model chain; recovery (v1: successful assistant completion; v2: raw `session.step.ended` with `stop`/`tool-calls`/`length`, or `session.execution.succeeded`), observed fresh descent from the configured primary, or deletion re-arms it. Stage-2 exhaustion blocks abort on subsequent retry statuses until a fresh descent.
- A retry arriving while a fallback is in progress is not admitted and does not
  consume retry budget; delayed fallback retains the triggering error for
  consistent inline-error toast suppression.
- With a chain, host backoffs longer than 30 minutes bypass the retry budget
  (`session.status.next` on v1, `decision.delay` on v2). Shorter or unspecified waits keep the count-based budget; no-chain behavior is unchanged.
- Confirmed permanent quota/billing failures bypass the initial fallback delay.
  The delay is consumed once per descent; later links use only consecutive
  fallback backoff, and a confirmed new external turn clears that backoff.

### State Management
- **Deduplication**: the short duplicate-observation window is scoped by the
  confirmed user-turn identity, model episode, and incident ID, so distinct
  failures on the same model are not merged. The window also rejects stale
  retry events from the previous model. Repeated retry attempt numbers are ignored before
  the chain-global retry budget is charged. Retry attempts withheld by the live-
  child guard remain eligible when the same attempt is observed after the guard
  clears.
- **Session cleanup**: `session.deleted` event handler removes all per-session state to prevent memory leaks
- **In-progress tracking**: Prevents concurrent fallback attempts on the same session across plugin-manager recreation
- Host calls within `inProgress` have bounded timeouts because the terminal gate's fallback fence depends on that window ending; a replay send timeout retains unresolved ownership without aborting or resending.

### Retry Budget and Exhaustion
- The v2 in-place retry hook (`handleV2Retry`) is gated by the separate `v2RetryEnabled` constructor flag — the replay path's `enabled` stays false on v2 hosts, so only steering runs there. It shares the chain-global budget and quota policy. Absorbed retries, recoverable failures, missing chains and unsuccessful model switches leave the host decision unchanged. Once `selectFallbackModel` returns `exhausted` the hook returns without touching the decision: the host's own retry verdict stands, so a spent chain never forces a retry. A first ordinary exhaustion still takes the sticky re-fallback (only the second lands here).
- `handleV2Retry` performs no turn-epoch fencing (removed with the retry state machine in 858c5bb4): the hook runs synchronously inside the host's retry decision for the currently failing turn, so no newer-turn write-back can race it. The only asynchronous window is the `switchModel` await; a timed-out switch that settles late is reconciled only while `sessionModel` equals the failed `from` model or the switch target. A different observed selection is left untouched.
- Observability + initial delay: the first retry-hook event per session and failing model logs a deterministic `[foreground-fallback] v2 retry hook observed` line (failover classification + steering state) before any guard returns, so a disabled or never-invoked hook is distinguishable in postmortems. The notice set clears on confirmed recovery and on a confirmed new v1 user turn, so a later failure episode is visible again. `fallback.initialRetryDelayMs` has no steering form (no replay to delay; the host's own retry backoff is the window) — noted once per session instead of silently disabling steering.
- v2 bookkeeping split: `handleEvent` runs agent/model tracking and confirmed-recovery resets whenever either path is enabled, while the replay interventions (`session.error`, `message.updated` error, `session.status` retry) stay gated behind `enabled`. Successful v2 steps and executions can clear descent state with replay disabled. `observeExternalTurn` separately records a model selected outside the confirmed fallback so returning to the configured primary can re-arm the descent.
- `maxRetries = N` absorbs failures `1..N` on the current model; failure `N+1` (and every later failure) advances the chain. `maxRetries = 0` switches immediately.
- The budget is **chain-global** and is not cleared on a model switch.
- The budget clears on confirmed recovery, `session.deleted`, a confirmed new v1 user turn, or an observed fresh descent from the configured primary outside our committed fallback. A new v2 turn alone does not reset it. A completed assistant `message.updated` with `finish: 'content-filter'` is not a successful response: OpenCode v1 publishes it before attaching the `ContentFilterError`, so it never clears the budget.
- **Permanent quota/billing failures** (`isPermanentQuotaBillingError`: 402, explicit spending / personal-team-blocked limits, credits exhausted, expired coding plans, weekly/monthly exhaustion, Zhipu billing codes) bypass the initial replay delay through `bypassInitialFallbackDelay` and skip the host retry budget, switching immediately regardless of `maxRetries`. The sticky re-fallback still applies.
- **Spent allowance** (`isSpentQuotaError`, issue #966: usage limit reached, quota/usage exceeded, without short-horizon retry wording in the same carrier; free-tier exhaustion exempt) records the failing provider in `quotaExhaustedProviders`. `surfacesSpentQuota` gates every trigger path: when no chain entry remains on another provider, it cancels any queued initial delay and leaves the error to the user (no switch, no abort). Otherwise the chain walk and the sticky pick skip exhausted providers, and the host retry budget is skipped. The record re-arms with the budget (recovery, new v1 turn, fresh descent, deletion); `rearmIfFreshDescent` does not treat a head on an exhausted provider as a fresh descent. Switches still add the provider to `activeFallback.downProviders` for delegated-child routing. Exhaustion is attributed to the model that failed, never to a replacement in `sessionModel`: `message.updated` uses the message's own model; an observation of an incident a fallback already handled (`triggerIncidents` records the model it failed on) is recorded there and never acts; a message-tied `session.error` that no fallback handled belongs to the current model; the v2 retry hook names the failing attempt's model (`event.model`) and attributes to it directly, its old-model late retries already dropped by the tried-model guard; any other spent-quota signal (uncorrelated `session.error`, `session.status` retry) is the last replay trigger's echo (`lastSwitchTrigger`, recorded by `isDeduped`) only when it repeats that trigger's spent-quota text in the same turn and dedup window, on an exhausted provider, before the replacement emits a message. An echo records nothing against the replacement and never fails over again; `selectFallbackModel` only re-marks the model the gate already attributed. Otherwise it belongs to the current model, so a cascade of spent quotas keeps advancing. A no-chain session surfaces spent quota at the gate, and `trySameModelRetry` treats it as deterministic, so it never takes the same-model replay.
- `chainExhaustion` stage 2 stops `tryFallbackWithAbort` and `selectFallbackModel`, so a spent chain does not keep aborting host retries.
- Stage 1 retries `chain[last]` once, ignoring provider exclusions and retaining
  tried models; a failure of that sticky retry reaches stage 2 without reopening
  the chain.
- `noteExternalTurn` cancels the initial-delay trigger, clears retry/dedup/backoff state and increments `turnEpoch`, retaining `replayMessageIds`. `isKnownInternalReplayUserMessage` checks retained IDs and event parts; `isInternalReplayUserMessage` probes the transcript when parts are missing. Duplicate user-message updates are inert. `userEventSequence` fences out-of-order probes, and `isCurrentTurn` prevents superseded replay work from claiming a switch. `rearmIfFreshDescent` clears tried/exhaustion state only after an observed return to the configured primary outside our committed fallback; a fallback onto the head keeps its descent state.

### Deduplication (identity-based)
- No error-text-only time-window heuristic: identical text can be the next real failure. The one-shot cross-event bridge requires an exact payload, current model, current turn, and short time-window match.
- `message.updated` dedupes by message id; `session.status` dedupes by the `retryAttempt` map (`{turn, model, attempt}`) with `attempt <= previous.attempt` comparison, so repeated/out-of-order attempts dedupe but an incremented attempt is processed. An id-less terminal event is otherwise unique; only an exact one-shot match to its paired error event reuses that incident.
- Dedup and the `inProgress` guard run **before** budget consumption, so a duplicate or concurrently-dropped event cannot burn a budget slot.

## Flow

### Event Processing Pipeline
```
OpenCode Event (message.updated/session.error/session.status)
    ↓
ForegroundFallbackManager.handleEvent()
    ↓
Failover error detection via isFailoverError()
    ↓
tryFallback(sessionID) [deduplicated, in-progress guarded]
    ↓
Resolve fallback chain for session
    ↓
Abort current rate-limited prompt (session.status retry path only, with timeout)
    ↓
Retrieve last user message from session history (replayed via isReplayableUserMessage/partsFromReplayMessage)
    ↓
Re-prompt session with next model via promptAsync()
    ↓
Update session state with new model
    ↓
Log fallback event
```

### Key Operations
1. **Abort with timeout**: `abortSessionWithTimeout()` calls `client.session.abort()` wrapped in a timeout (default 1000ms).
2. **Message retrieval**: Queries session messages via `client.session.messages()` and finds last user message
3. **Model switching**: Uses `parseModelReference()` to extract providerID/modelID from chain entry
4. **Re-prompting**: Calls `promptAsync()` which queues prompt and returns immediately (non-blocking); appends trusted internal-initiator provenance so the replay is not mistaken for new external user input
5. **Failover deferral**: Recoverable child errors (`isFailoverError`) leave terminal bookkeeping to the task-session-manager. Its backstop waits for replay preparation, renewing at most five times, and clears the deferral before publishing an unrecovered error. `fallbackFailureReason()` adds the disabled, missing-chain, exhausted-chain (with tried models), or failed-model explanation. Non-failover errors retain their original text.
6. **Fallback ownership**: Admitted and unresolved-promoted replays retain a tracker flag until external registration replaces the run. Plugin wiring makes v1 `task_revive` refuse pending or running fallback work; `task_cancel` remains available. v2 steering creates no replay flag or refusal.
7. **Continuation notice**: A confirmed replay after a terminal failover error queues one internal `state="running"` notice with the failed model, provider error and model now running. The tracker uses the same parent transport as terminal delivery and waits for the notice attempt to settle before sending the result. Retry-path replays, superseded or unresolved admissions, promoted owners and v2 steering send no notice.

## Integration

### Consumers
- **Primary**: Main plugin initialization (`src/index.ts`) creates ForegroundFallbackManager instance
- **Delegation routing**: Main plugin reads `getActiveFallback`. Independent
  children move only if their primary provider is in `downProviders`, taking
  their first chain entry outside that set. Inherited children follow the
  record's live model even after request-scoped failures. Manual model choices
  do not create a fallback record. A child's later fallback picks also skip
  providers abandoned by its parent, linked through `sessionParent`.
- **Event source**: OpenCode plugin event system provides `message.updated`, `session.error`, `session.status`, `session.deleted` events

### Dependencies
- **OpenCode SDK**: `PluginInput['client']` for session management and event handling (accessed via `getClient()` from `src/utils/opencode-client.ts`)
- **Utilities**:
  - `abortSessionWithTimeout()`: Graceful session termination
  - `parseModelReference()`: Model string parsing ("providerID/modelID")
  - `createInternalAgentTextPart()`: Internal-initiator provenance for replays
  - `log()`: Structured logging for observability
- **SessionLifecycle** (`src/hooks/session-lifecycle.ts`): registers `session.deleted` cleanup
- **Background job board** (`src/index.ts`): supplies a synchronous `hasRunning(sessionID)` child check for the optional v1 abort guard; the failing background job itself is not counted as its own child
- **Message types** (`src/hooks/types.ts`): `isReplayableUserMessage` / `partsFromReplayMessage` for safe replay
- **Configuration**: Fallback chains provided at construction from agent configurations

### Configuration Schema
Fallback chains are provided as `Record<string, ReadonlyArray<ForegroundFallbackModel>>` where:
- Key: Agent name (e.g., "orchestrator", "explorer")
- Value: Ordered list of model strings (e.g., `["anthropic/claude-opus-4-5", "openai/gpt-4o"]`)

### Memory Management
- **Per-session state**: All maps cleared on `session.deleted` event
- **Deduplication**: Prevents unbounded growth in long-running instances with many subagent sessions

### Observability
- **Logging**: Structured logs at key points:
  - Rate-limit detection
  - Fallback initiation
  - Model switching
  - Chain exhaustion
  - Abort failures
  - PromptAsync unavailability

## Error Handling
- **Graceful degradation**: Best-effort approach; abort may be slow or incomplete
- **Recovery**: v1 uses completed successful assistant responses; v2 uses raw
  `session.execution.succeeded` or `session.step.ended` with `finish` `stop`,
  `tool-calls` or `length` to reset tried/retry/exhaustion state. Other step
  finishes and synthesized `v2-usage:` messages never prove recovery.
- **Validation**: Checks for `promptAsync` availability before attempting re-prompt
- **Fallback exhaustion**: Logs when entire chain has been attempted without success
- **Invalid model format**: Skips malformed model references
- **Missing user message**: Aborts fallback attempt if no user message found in history
