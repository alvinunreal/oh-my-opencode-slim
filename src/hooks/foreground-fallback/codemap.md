# src/hooks/foreground-fallback/

## Responsibility
Runtime model fallback system for foreground (interactive) agent sessions. When OpenCode emits failover signals via `message.updated`, `session.error`, or `session.status` events, this manager:
- Classifies retryable conditions with `isFailoverError` (message/transport patterns plus a nested HTTP status-code probe)
- Applies a chain-global retry budget (`fallback.maxRetries`): the first N current-model failures are absorbed, later failures advance the fallback chain
- Absorbs a `session.status: retry` event by letting the host continue its own retry loop (no extra prompt)
- Absorbs a terminal error (`session.error` / `message.updated` error) by actively replaying the current user request on the **current** model
- Aborts and re-prompts the next chain model once the budget is spent, or on demand via the `session.status` abort path
- On v1, withholds `session.abort(X)` while the background job board reports running children of X: held retry events do not seal dedup, exhausted chains still stop intervening, and busy replay errors withdraw any armed handoff when the abort is withheld (explicit refusal admits nothing), and settle it only after a failed abort with unknown outcome. v2 and v1 sessions without running children retain their abort behavior. `session.error` and `message.updated` can re-prompt directly without abort.
- Operates reactively through the event system (cannot wrap `prompt()` directly for interactive sessions)
- Defers terminal job-board bookkeeping for inline 401/410 errors while recovery is still possible (cooperates with task-session-manager's `willAttemptFallback`)

## Design

### Core Abstraction
- **ForegroundFallbackManager**: Class instantiated at plugin initialization; process-local fallback progress is shared across replacement instances
- On v2 hosts (`hostFlavor === 'v2'`) the manager is constructed **disabled** (`enabled=false`) even when `fallback.enabled !== false`, with one deterministic startup log: the v2 `switchModel` has no per-turn/atomic conditional form, so an in-flight switch could commit after a newer user turn took over. Host-native retries and their decisions are untouched; the whole manager is gated because `session.error`, `message.updated` and `session.status` retry all reach the replay path, not just the retry hook. v1 is unchanged.
- Per-session state:
  - `sessionModel` / `sessionAgent` / `sessionTried`: current model, agent name, models already attempted
  - `sessionRetries`: chain-global count of absorbed current-model retries (not reset by a model switch)
  - `chainExhaustion`: stage `0` (fresh) / `1` (first exhaustion, sticky fallback) / `2` (terminal, aborted)
  - `lastTrigger` / `lastTriggerModel`: anchor for the stale-retry guard
  - `lastTriggerMap`: identity-based dedup keys → timestamps
  - `retryEpisode`: per-session `session.status` retry episode (model, episode id, seen attempts)
  - `initialDelayScheduled` / `pendingInitialDelay`: one initial-delay trigger per descent
  - `pendingReplay`: identity of a just-issued internal replay (target model, baseline message id, admitted flag, window) so the replay's own user message, even when it arrives after `promptAsync` returned, is not mistaken for a real new turn. It is retained across a confirmed new turn (`freshTurnResetHandler` does NOT drop it) so a late, not-yet-persisted replay notification is still recognisable; the `turnEpoch` bump fences the stale replay's own writes.
  - `replayMessageIds`: user message ids positively confirmed as our own internal replay. Retained for the session's lifetime (cleared on `session.deleted`/`dispose`), so repeated late notifications for the same replay stay idempotent even after `pendingReplay` is cleared, across later replays and across external turns. Memory grows only with the session's replay count.
  - `v2RetryTerminal`: sessions the v2 in-place retry hook has put into a terminal state (chain exhaustion once stage 2 is reached — ordinary or permanent quota). Later retry-hook calls answer `{ retry: false }` until a completed successful assistant response, a genuine new turn returning to the configured primary, or session deletion/dispose clears it — kept in lock-step with `chainExhaustion`.
  - `turnEpoch`: bumped on every confirmed external user turn. Each fallback entry point (`tryFallback` / `tryFallbackWithAbort` / `retryCurrentModel`) captures the epoch at its entry and threads it through promotion, abort, backoff and `execFallback` into `replayFallbackPrompt`. Every suspension point re-checks it, so a fallback suspended on promotion/abort/backoff/transcript-read is abandoned rather than switching the newer turn; `tryFallback` also records `lastFallbackTime` only when the attempt still belongs to the current turn (epoch-checked), so a superseded attempt cannot delay the new turn's next fallback with an inherited `retryDelayMs` sleep. `replayFallbackPrompt` (when reached directly) still captures the epoch before its first await and re-checks it before every replay send, before the busy-path abort, and before any model/switch state write. `handleV2Retry` also captures it before the model-switch await (see the v2 retry bullet below).
  - `userTurnSeq` / `userTurnLatest`: user-turn handling is versioned so probes that resolve out of order cannot roll back a newer turn. `handleUserTurn` takes a monotonically increasing `seq` before awaiting its transcript probe; internal replays never claim the slot, and a confirmed-external handler is dropped if a newer turn (higher `userTurnLatest`) already applied. `userTurnLatest` is cleared on `session.deleted`/`dispose`.
  - `inProgress`: process-global Set of sessions with an active retry/fallback, shared via `globalThis` + `Symbol.for`

### Decision Function
`decideIntervention(sessionID, needsAbort)` consumes one budget unit and returns:
- `'absorb'` — budget remained (terminal path → `retryCurrentModel`, host-retry path → no-op)
- `'fallback-delayed'` — budget spent but `initialRetryDelayMs` scheduled the first delayed trigger
- `'fallback'` — budget spent → `tryFallback` / `tryFallbackWithAbort`

### Retryable Error Detection
- **Patterns**: rate-limit/quota/outage/401/403/410 wording, transport codes (`ECONNRESET`, …) and transport messages
- **Status-code probe** (`probeStatusCode`): priority order `statusCode` → `data.statusCode` → `cause.statusCode` → `status` → `response.status` → `response.statusCode` → `data.status` → `data.response.status` → `cause.status` → `cause.response.status`. `asHttpStatus` accepts only finite `100–599` codes (number or 3-digit numeric string), so arbitrary numeric fields are never mistaken for a status.
- **Diagnostics**: when a status code is found, `isFailoverError` emits one compact `failover status diagnosis` log (direct code, candidate `path=value` list, selected code, verdict). Response bodies, tokens and prompts are never logged.
- **Event coverage**: `message.updated` (message metadata error), `session.error` (session-level error), `session.status` (`retry` status)

### Retry Budget and Exhaustion
- The v2 in-place retry hook shares the chain-global budget and quota policy. Absorbed retries, recoverable failures, missing chains and unsuccessful model switches leave the host decision unchanged. Once `selectFallbackModel` returns `exhausted` (stage 2 reached by an ordinary or a permanent quota error), the hook records a per-session terminal reason and sets `event.decision = { retry: false }`; every later retry-hook call on that session answers `{ retry: false }` before classification, delay and model selection. A first ordinary exhaustion still takes the sticky re-fallback (only the second lands here). The reason clears on a completed successful assistant response (in lock-step with stage 2), on `session.deleted`, `dispose`, and only when a genuine new user turn actually reopens stage 2 at the configured primary.
- `handleV2Retry` captures the turn epoch at entry, before the `switchModel` await, and applies it to all three writes: the success path skips `event.decision`, `sessionModel.set`, `onSessionModelChanged`, the toast and the switched-log when the epoch moved (leaving the host decision untouched so it retries the current turn); the failure cleanup only rolls the target off `sessionTried` while the epoch still matches; and the late-landing reconcile callback bails when the epoch moved, so a timed-out switch that settles after a newer turn cannot write back.
- `maxRetries = N` absorbs failures `1..N` on the current model; failure `N+1` (and every later failure) advances the chain. `maxRetries = 0` switches immediately.
- The budget is **chain-global** and is not cleared on a model switch.
- Cleared only on: a completed successful assistant response, `session.deleted`, or a confirmed new user turn.
- **Permanent usage/quota failures** (`isPermanentUsageQuotaError`: 402, explicit spending / personal-team-blocked limits, "coding plan package has expired", fixed-window limit reached/exhausted, explicit quota exhausted, provider billing codes) skip the budget entirely — no same-model replay — and never take the sticky re-fallback; `execFallback` aborts at stage 2 when the chain is spent. Ordinary 429 / rate-limit / short-term "quota threshold" wording keeps using the configured budget.
- `isExhausted` (stage 2) short-circuits every failover event and both `tryFallback`/`tryFallbackWithAbort`, so a spent chain aborts at most once.
- `freshTurnResetHandler` runs on a confirmed new `user` turn (the SDK `UserMessage` nests the model under `info.model`; assistant messages keep it top-level): it cancels a pending initial-delay trigger and clears the budget, retry episode, `sessionTried`, dedup anchors and `lastFallbackTime`, retains `pendingReplay` (so a late replay notification is still recognised), and bumps `turnEpoch`. Identity is decided BEFORE any state write: `handleUserTurn` treats a message as internal when its id is retained (`replayMessageIds`), matches the pending baseline, or — after ALWAYS probing the transcript via `probeReplayMessageIdentity` — shows the internal-initiator marker; a message present in the transcript WITHOUT the marker is a real turn even while a replay is in flight, and an unpersisted (`unknown`) message is treated as internal while a replay is in flight OR a usable `pendingReplay` record is retained (never shortcut to external merely because nothing is in flight). An in-flight replay whose `turnEpoch` advanced skips its model/switch claim and its switched-log/toast, so a superseded replay cannot write back into the newer turn. Turn handling is versioned (`userTurnSeq`/`userTurnLatest`): the newest confirmed-external handler wins, so a probe resolving out of order is dropped rather than rolling back a newer turn. Un-sealing the stage-2 terminal guard additionally requires the turn to return to `chain[0]`.

### Deduplication (identity-based)
- No error-text + time-window heuristic: identical text can be the next real failure.
- `message.updated` dedupes by message id; `session.status` dedupes by `retryEpisode` (model + episode id + `seen` attempts, so repeated/out-of-order attempts dedupe but an incremented attempt is processed); terminal events with **no** correlatable id are never deduped.
- Dedup and the `inProgress` guard run **before** budget consumption, so a duplicate or concurrently-dropped event cannot burn a budget slot.

## Flow

### Event Processing Pipeline
```
OpenCode Event (message.updated / session.error / session.status)
    ↓
ForegroundFallbackManager.handleEvent()
    ↓
isExhausted? → return (terminal stage 2)   |   inProgress? → return
    ↓
Identity dedup gate (message id / retry episode / none)
    ↓
decideIntervention() → consume one budget unit
    ↓ absorb (terminal)                    ↓ absorb (host retry)   ↓ fallback
retryCurrentModel()                        no-op                  tryFallback* (entryEpoch captured)
    ↓                                                              ↓ promotion/abort/backoff: epoch re-check
replayFallbackPrompt(current model, entryEpoch)                    replayFallbackPrompt(next model, entryEpoch)
    ↓
promptAsync() [tail transcript read → full read fallback]
    ↓
admit background handoff · claim switch (fallback only) · toast
```

User-turn handling is versioned: `handleUserTurn` takes a `seq` before its identity probe and only the newest confirmed-external handler may write the model and reset the budget, so an older probe resolving late cannot roll back a newer turn.

### Shared Replay
`replayFallbackPrompt(sessionID, targetModel, fromModel, isModelSwitch, error, expectedEpoch?)` is used by both `execFallback` (model switch) and `retryCurrentModel` (same model):
- Uses the fallback entry's `expectedEpoch` when threaded through (so a turn that started during outer promotion/abort/backoff is caught), otherwise captures `replayEpoch` before the first await. Checks it (a) before enrolling `pendingReplay`/the first send, (b) before the busy-path abort, and (c) before the second send — a superseded attempt logs `fallback superseded by a newer turn; fallback aborted` and returns without sending, enrolling a record, or writing model/switch state.
- Reads only the transcript tail (`FALLBACK_REPLAY_TAIL_MESSAGES`) with a full-read fallback; preserves both read errors.
- Arms the background observation handoff before the admission await and admits it exactly once on acceptance.
- On a busy-session `promptAsync` failure, promotes a foreground waiter, aborts, waits `REPROMPT_DELAY_MS`, and retries **once**. An abort transport failure logs `fallback abort failed`; a rejected second prompt logs `retry prompt failed`. Both convert the armed handoff (never drop it), end the attempt without further retry, and let the caller's `finally` release `inProgress`.

## Integration

### Consumers
- **Primary**: Main plugin initialization (`src/index.ts`) creates the manager and passes `fallback.maxRetries`, `initialRetryDelayMs`, `retryDelayMs`
- **Event source**: OpenCode plugin event system (`message.updated`, `session.error`, `session.status`, `session.deleted`, `session.created`, `subagent.session.created`)

### Dependencies
- **OpenCode SDK**: `PluginInput['client']` via `getClient()` (`src/utils/opencode-client.ts`)
- **Utilities**: `abortSessionWithTimeout()`, `parseModelReference()`, `createInternalAgentTextPart()`, `log()`
- **SessionLifecycle** (`src/hooks/session-lifecycle.ts`): registers `session.deleted` cleanup
- **Message types** (`src/hooks/types.ts`): `isReplayableUserMessage` / `partsFromReplayMessage`
- **Background job board** (`src/index.ts`): supplies a synchronous `hasRunning(sessionID)` child check for the optional v1 abort guard; the failing background job itself is not counted as its own child

### Configuration
- Chains: `Record<string, string[]>` (agent name → ordered model list)
- Live fallback config: `fallback.enabled`, `fallback.maxRetries`, `fallback.initialRetryDelayMs`, `fallback.retryDelayMs`
- Legacy keys (`timeoutMs`, `retry_on_empty`, `runtimeOverride`) are stripped by the schema with a deprecation warning and have no effect

### Memory Management
- `session.deleted` clears every session-level map (models, tried, dedup keys, retry episode, budget, exhaustion, pending timers) so a reused session id starts fresh
- Dedup keys are pruned once outside the 5s window

### Observability
Structured logs at: retry-budget absorb/fallback, delaying initial fallback, failover status diagnosis, switched to fallback model, fallback abort failed, retry prompt failed, fallback superseded by a newer turn, chain-exhaustion stage transitions, fresh-turn reset, promptAsync unavailable.

## Error Handling
- **Graceful degradation**: abort/promotion may be slow or incomplete; failures are fail-soft
- **Bounded submission retries**: at most one re-prompt after a busy-session abort; no infinite retry, no permanent `inProgress` leak
- **Exhaustion**: stage 2 is terminal (no repeat abort); a confirmed new user turn restores one fresh descent
- **Invalid model format / missing user message**: the replay is skipped without mutating chain state
