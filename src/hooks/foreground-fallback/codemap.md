# src/hooks/foreground-fallback/

## Responsibility

`ForegroundFallbackManager` steers foreground sessions when OpenCode 2.3
reports a retryable provider failure, a content-filter refusal, or a no-route
failure. The retry hook changes the model in place through `session.switchModel`.
The refusal and no-route paths use the same selection logic and send an internal
continuation when the switch succeeds.

## Retry and selection

- `handleV2Retry` classifies the error with `failoverScope` and is controlled by
  `v2RetryEnabled` or the session's pinned setting. Provider failures, transport,
  authentication, and quota errors have provider scope. Content-filter and
  model-availability failures have request scope.
- `maxRetries` counts eligible host retries across the current descent. Request
  rejections and permanent or spent quota skip that budget. A structured
  `provider.auth` 401 receives one immediate retry per turn.
- Host backoffs longer than 30 minutes bypass the retry budget when a chain is
  available. `initialRetryDelayMs` has no steering equivalent; the host's own
  retry backoff provides the recovery window.
- `switchV2InPlace` calls `selectFallbackModel`, waits for the host switch, and
  commits the result. A timed-out switch that later settles is reconciled only
  if the turn and observed model still match. An in-flight switch prevents a
  concurrent attempt for the same session.
- Chains are pinned per session from the generation published by `src/index.ts`.
  A known agent uses its own chain. When the agent is unknown, resolution may
  infer a chain from the current model or merge the available chains.
- Selection skips tried models and provider marks for the session and its
  parent. Request-scoped rejections remain excluded for the request. The last
  eligible entry gets one sticky retry; the next exhaustion leaves the host
  decision unchanged.
- Spent allowance marks the failing provider in `quotaExhaustedProviders`.
  Once no chain provider remains available, the failure surfaces without a
  switch. Provider failure marks used for child routing expire after 30 minutes.

## Refusals and no-route failures

`session.step.started` records the assistant, agent, model, and turn epoch.
`session.step.failed` with `finish: 'content-filter'` claims one refusal outcome
per assistant. Before switching, the manager checks the durable session selection
and the captured turn. A newer turn during the switch prevents the continuation,
while the confirmed model selection remains durable.

For `provider.no-route`, the manager reads the latest context anchor. A root
session can fall back to a bounded transcript tail when the context read fails.
Roots and children continue in place; OpenCode delivers a child's settled result
to its parent. Host calls are bounded by timeouts.

## Session state

- `sessionModel` tracks observed models; `activeFallback` records confirmed
  switches. An external selection of a different model clears the fallback
  record and its provider marks.
- `sessionAgent`, `sessionParent`, and pinned chains determine routing.
- `sessionTried`, `sessionRetries`, `requestRejected`, `authGrace`, and
  `chainExhaustion` track the current descent. Confirmed recovery, deletion,
  or an observed return to an eligible primary can re-arm the descent.
- `turnEpoch` fences retry work across a new external prompt.
  `observedUserMessageIds` and internal admission markers prevent stale or
  synthetic user messages from being treated as new turns.
- `inProgress` is process-global, so a replacement manager sees a switch still
  owned by its predecessor. `session.deleted` cleans up per-session state
  without releasing an in-flight switch's ownership.

Confirmed recovery comes from `session.execution.succeeded` or
`session.step.ended` with `stop`, `tool-calls`, or `length`. Synthesized usage
messages and other finishes do not establish recovery.

## Integration

`src/index.ts` constructs the manager and supplies chains and runtime options.
The v2 bridge forwards retry hooks and lifecycle events. `SessionLifecycle`
coordinates deletion cleanup, while `getActiveFallback` exposes the confirmed
model and provider marks to delegation routing.
