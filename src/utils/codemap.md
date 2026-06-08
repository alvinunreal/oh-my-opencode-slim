# src/utils/

Cross-cutting runtime utilities used by orchestration, hooks, and plugin I/O.

## Responsibility

- **background-job-board.ts**: Tracks V2 background jobs by parent session,
  assigns aliases, records read context, and exposes reusable completed /
  reconciled sessions with prompt rendering and reusable LRU caps.
- **tmux.ts**: Multiplexer-safe pane lifecycle helpers (`spawnPane`, `closePane`)
  used by tmux and zellij adapters.
- **subagent-depth.ts**: Tracks delegated session depth and enforces max nested
  delegation depth.
- **agent-variant.ts**: Normalizes agent names and applies optional variant
  labels without overriding existing body configuration.
- **env.ts**: Unified environment lookup across Bun/Node with empty-string
  filtering.
- **session.ts**: Session extraction helpers for multi-turn synthesis and
  prompt/result post-processing.
- **polling.ts**: Shared polling with stability thresholds and abort-signal
  support.
- **zip-extractor.ts**: Cross-platform zip/tar extraction with Windows fallback
  tooling.
- **task.ts**: Parses native `task` output and injected background completion text.
- **system-collapse.ts**: Collapses multiple system prompt fragments into one
  array element while mutating the original array reference.
- **logger.ts**: Structured JSON logging to temporary files.
- **internal-initiator.ts**: Marker utilities for internal orchestrator text-part
  tagging.
- **compat.ts**: Backward compatibility helpers.
- **index.ts**: Public re-export barrel for utility modules.

## Design

- **Parent-scoped background job board**: `BackgroundJobBoard` tracks
  active/unreconciled jobs separately from completed/reconciled reusable
  sessions; reusable entries are LRU-capped per parent+agent.
- **Deterministic lifecycle tracking**: `SubagentDepthTracker` maps session IDs to
  depth and is cleaned on session deletion.
- **Provider-safe env access**: `getEnv` falls back from `Bun.env` to
  `process.env` and normalizes blank values.
- **Graceful shutdown protocol**: Multiplexer pane close path sends Ctrl+C before
  kill, then rebalances layout state.
- **Session extraction model**: `extractSessionResult`/`parseModelReference`
  helpers are centralized under `session.ts`.
- **In-place system normalization**: `collapseSystemInPlace` mutates `system` to
  preserve references held by OpenCode internals.
- **Resilient polling**: `pollUntilStable` requires consecutive confirmations
  before success.

## Flow

### `background-job-board.ts`

- `deriveTaskSessionLabel` computes a deterministic prompt hint from
  `description`, the first non-empty `prompt` line, or a fallback agent label.
- `registerLaunch` creates/reopens running jobs and assigns monotonic aliases
  within each parent+agent (`exp-1`, `lib-2`, etc.).
- `updateStatus` marks terminal jobs unreconciled; `markReconciled` makes only
  completed terminal jobs reusable.
- `resolveReusable`, `markUsed`, `drop`, and `clearParent`
  keep job aliases consistent on polling, reuse, and teardown.
- `formatForPrompt` returns the unified `### Background Job Board` prompt section
  with Active / Unreconciled and Reusable Sessions subsections.

### `tmux.ts`

- `spawnPane` flow: validate enabled state → check multiplexer availability →
  resolve binary → execute attach command with layout handling.
- `closePane` flow: send SIGINT-equivalent key sequence → delay → terminate pane
  → rebalance layout if needed.
- `isServerRunning` flow: bounded `/health` checks with retries and caching.

### `polling.ts`

- `pollUntilStable(fn, options)` repeatedly calls async predicate and tracks
  consecutive true states.
- Returns once stable threshold is met, timeout elapses, or abort signal is
  raised.

### `session.ts`

- Composes prompt parts and extracts normalized session output for text/call/result
  flows.
- Hosts shared parsing/formatting utilities used by council and tool execution
  layers.

### `task.ts`

- Scans task output line-by-line and extracts `task_id`, state, timeout, and
  result summary fields.

### `system-collapse.ts`

- `collapseSystemInPlace(system: string[])` joins system entries with `\n\n`,
  clears and repopulates the same array reference, and preserves empty-array
  behavior.

## Integration

- **Consumers**
  - `src/multiplexer/*`: `SubagentDepthTracker` and `tmux.ts` integration.
  - `src/council/council-manager.ts`: depth control and session extraction
    helpers.
  - `src/hooks/*`: marker detection, polling, and session-aware state helpers.
  - `src/hooks/task-session-manager`: `BackgroundJobBoard`, task-output parsing,
    and `deriveTaskSessionLabel` provide V2 background job polling/reuse workflow
    through message-transform prompt injection.
- **Dependencies**
  - Pulls constants from `../config` (`DEFAULT_MAX_SUBAGENT_DEPTH`, polling
    intervals/timeouts).
  - `index.ts` re-exports utility API.
