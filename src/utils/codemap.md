# src/utils/

Cross-cutting runtime utilities used by orchestration, hooks, and plugin I/O.

## Responsibility

- **tmux.ts**: Multiplexer-safe pane lifecycle helpers (`spawnPane`, `closePane`) used by tmux and zellij adapters.
- **subagent-depth.ts**: Tracks delegated session depth and enforces max nested delegation depth.
- **agent-variant.ts**: Normalizes agent names and applies optional variant labels without overriding existing body configuration.
- **env.ts**: Unified environment lookup across Bun/Node with empty-string filtering.
- **session.ts**: Session extraction helpers for multi-turn synthesis and prompt/result post-processing.
- **polling.ts**: Shared polling with stability thresholds and abort-signal support.
- **zip-extractor.ts**: Cross-platform zip/tar extraction with Windows fallback tooling.
- **logger.ts**: Structured JSON logging to temporary files.
- **internal-initiator.ts**: Marker utilities for internal orchestrator text-part tagging.
- **compat.ts**: Backward compatibility helpers.
- **index.ts**: Public re-export barrel for utility modules.

## Design

- **Deterministic lifecycle tracking**: `SubagentDepthTracker` maps session IDs → depth and is cleaned on session deletion.
- **Provider-safe env access**: `getEnv` falls back from `Bun.env` to `process.env` and normalizes blank values.
- **Graceful shutdown protocol**: Multiplexer pane close path sends Ctrl+C before kill, then rebalances layout state.
- **Session extraction model**: `extractSessionResult`/`parseModelReference` style helpers are centralized under `session.ts`.
- **Resilient polling**: `pollUntilStable` requires consecutive confirmations before success.

## Flow

### `subagent-depth.ts`

- `registerChild(parentSessionId, childSessionId)` computes `childDepth = parentDepth + 1`.
- Blocks registration when depth exceeds `DEFAULT_MAX_SUBAGENT_DEPTH`.
- `cleanup(sessionId)` and `cleanupAll()` remove depth state for terminated sessions.

### `tmux.ts`

- `spawnPane` flow: validate enabled state → check multiplexer availability → resolve binary → execute attach command with layout handling.
- `closePane` flow: send SIGINT-equivalent key sequence → delay → terminate pane → rebalance layout if needed.
- `isServerRunning` flow: bounded `/health` checks with retries and caching.

### `polling.ts`

- `pollUntilStable(fn, options)` repeatedly calls async predicate and tracks consecutive true states.
- Returns once stable threshold is met, timeout elapses, or abort signal is raised.

### `session.ts`

- Composes prompt parts and extracts normalized session output for text/call/result flows.
- Hosts shared parsing/formatting utilities used by council and tool execution layers.

## Integration

- **Consumers**
  - `src/multiplexer/*`: `SubagentDepthTracker` and `tmux.ts` integration.
  - `src/council/council-manager.ts`: depth control and session extraction helpers.
  - `src/hooks/*`: marker detection, polling, and session-aware state helpers.

- **Dependencies**
  - Pulls constants from `../config` (`DEFAULT_MAX_SUBAGENT_DEPTH`, polling intervals/timeouts).
  - `index.ts` re-exports utility API (`agent-variant`, `env`, `polling`, `logger`, `session`, `subagent-depth`, etc.).
