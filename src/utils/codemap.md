# src/utils/

Cross-cutting runtime utilities used by orchestration, hooks, and plugin I/O.

## Responsibility

- **tmux.ts**: Multiplexer-safe pane lifecycle helpers (`spawnPane`, `closePane`) used by tmux and zellij adapters.
- **subagent-depth.ts**: Tracks delegated session depth and enforces max nested delegation depth.
- **agent-variant.ts**: Normalizes agent names and applies optional variant labels without overriding existing body configuration.
- **env.ts**: Unified environment lookup across Bun/Node with empty-string filtering.
- **session-manager.ts**: Tracks resumable `task` tool sessions by parent session + agent type, normalizes user labels, assigns stable short aliases, and exposes prompt rendering/eviction behavior.
- **session.ts**: Session extraction helpers for multi-turn synthesis and prompt/result post-processing.
- **polling.ts**: Shared polling with stability thresholds and abort-signal support.
- **zip-extractor.ts**: Cross-platform zip/tar extraction with Windows fallback tooling.
- **task.ts**: Parses `task` tool CLI output to recover `task_id` for resumption.
- **system-collapse.ts**: Collapses multiple system prompt fragments into one array element while mutating the original array reference.
- **logger.ts**: Structured JSON logging to temporary files.
- **internal-initiator.ts**: Marker utilities for internal orchestrator text-part tagging.
- **compat.ts**: Backward compatibility helpers.
- **index.ts**: Public re-export barrel for utility modules.

## Design

- **Deterministic lifecycle tracking**: `SubagentDepthTracker` maps session IDs → depth and is cleaned on session deletion.
- **Parent-scoped resumable session store**: `SessionManager` groups tasks by `{parentSessionId, agentType}` and maintains LRU-ish ordering by last-used counter so active resumable sessions stay in memory.
- **Provider-safe env access**: `getEnv` falls back from `Bun.env` to `process.env` and normalizes blank values.
- **Graceful shutdown protocol**: Multiplexer pane close path sends Ctrl+C before kill, then rebalances layout state.
- **Session extraction model**: `extractSessionResult`/`parseModelReference` style helpers are centralized under `session.ts`.
- **In-place system normalization**: `collapseSystemInPlace` purposely mutates `system` array to preserve references held by OpenCode internals.
- **Resilient polling**: `pollUntilStable` requires consecutive confirmations before success.

## Flow

### `subagent-depth.ts`

- `registerChild(parentSessionId, childSessionId)` computes `childDepth = parentDepth + 1`.
- Blocks registration when depth exceeds `DEFAULT_MAX_SUBAGENT_DEPTH`.
- `cleanup(sessionId)` and `cleanupAll()` remove depth state for terminated sessions.

### `session-manager.ts`

- `deriveTaskSessionLabel` computes a deterministic prompt hint:
  - uses `description` if provided,
  - falls back to first non-empty normalized line of `prompt`,
  - else returns `recent {agentType} task`.
- `remember` creates/reuses entries keyed by `{parentSessionId, agentType}` and enforces a per-agent max via `trimGroup`.
- Alias generation is monotonic within each parent+agent (`exp-1`, `lib-2`, etc.).
- `markUsed`, `resolve`, `drop`, `dropTask`, `clearParent` keep the store consistent on reuse and teardown.
- `formatForPrompt` returns grouped and ranked prompt text (`### Resumable Sessions ...`) for use in system transforms.

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

### `task.ts`

- Scans task output line-by-line and extracts `task_id` from `task_id: <id>` format.

### `system-collapse.ts`

- `collapseSystemInPlace(system: string[])` joins all system entries using `\n\n`, clears and repopulates the same array reference, and preserves empty-array behavior.

## Integration

- **Consumers**
  - `src/multiplexer/*`: `SubagentDepthTracker` and `tmux.ts` integration.
  - `src/council/council-manager.ts`: depth control and session extraction helpers.
  - `src/hooks/*`: marker detection, polling, and session-aware state helpers.
  - `src/hooks/task-session-manager`: `SessionManager`, `parseTaskIdFromTaskOutput`, and `deriveTaskSessionLabel` provide resumable-session workflow; the plugin’s system-transform passes the hook output through `collapseSystemInPlace` after this manager injects prompts.

- **Dependencies**
  - Pulls constants from `../config` (`DEFAULT_MAX_SUBAGENT_DEPTH`, polling intervals/timeouts).
  - `index.ts` re-exports utility API (`agent-variant`, `env`, `polling`, `logger`, `session`, `subagent-depth`, etc.).
