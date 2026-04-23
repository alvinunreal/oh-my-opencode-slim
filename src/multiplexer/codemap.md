# src/multiplexer/

## Responsibility

- Provide multiplexer-backed visualization for spawned subagent sessions.
- Select and instantiate terminal backend based on config/env:
  `auto`, `tmux`, `zellij`, or `none`.
- Manage lifecycle of child session panes with lifecycle hooks from OpenCode
  events plus health/polling fallback.
- Keep pane cleanup safe and graceful (best-effort interrupt + kill).

## Design

- `types.ts`
  - Defines shared abstractions:
    - `Multiplexer` (`spawnPane`, `closePane`, `applyLayout`, `isAvailable`,
      `isInsideSession`),
    - `PaneResult`,
    - `isServerRunning(serverUrl, timeoutMs?, maxAttempts?)` for readiness checks.

- `factory.ts`
  - Creates fresh multiplexer instance per call (no cache) so env-specific
    state (`TMUX`, `ZELLIJ`) is captured accurately.
  - `auto` mode resolves strictly by env vars and can become no-op `none`.
  - Exposes `getAutoMultiplexerType` and `startAvailabilityCheck` for diagnostics.

- `tmux/index.ts` (`TmuxMultiplexer`)
  - Detects binary lazily via `which/where` + `tmux -V`.
  - `spawnPane` executes `opencode attach` in a split pane,
    sets pane title, and applies layout.
  - `closePane` sends `C-c`, waits briefly, then `kill-pane`.
  - `applyLayout` handles main layout sizing and rebalance.

- `zellij/index.ts` (`ZellijMultiplexer`)
  - Detects and reuses/creates `opencode-agents` tab.
  - First child uses default pane in that tab; additional children create panes.
  - Falls back to first available pane ID heuristics and restores original tab
    context around cross-tab operations.
  - Layout configuration is accepted but effectively no-op (tool semantics differ
    from tmux).

- `session-manager.ts` (`MultiplexerSessionManager`)
  - Initialized once from plugin context and config.
  - Subscribes to lifecycle events:
    - `session.created`: spawn pane if enabled and not already tracked,
    - `session.status`: close on `idle`, respawn on `busy` when known,
    - `session.deleted`: close pane and clear tracking.
  - Tracks:
    - active panes (`sessions` map),
    - known sessions (`knownSessions`),
    - in-flight spawns (`spawningSessions`).
  - `respawnIfKnown` handles busy sessions that reappear after being closed.
  - Polling fallback (`pollSessions`) is enabled when event coverage is incomplete.
    It handles:
    - idle detection,
    - missing status grace period,
    - max session lifetime timeout.

- `index.ts`
  - Re-exports factory, manager, and implementations for external import.

## Flow

- `src/index.ts` reads multiplexer config and creates
  `MultiplexerSessionManager(ctx, config)`.
- On startup `getMultiplexer(config)` determines backend and whether manager is
  enabled (`type != none`, multiplexer present, running inside session).
- On `session.created`:
  - checks backend health via `isServerRunning(serverUrl)`,
  - spawns a new pane,
  - starts background polling.
- On `session.status`:
  - `idle` → `closeSession` (close pane + remove mapping),
  - `busy` → `respawnIfKnown` if session was previously known.
- On `session.deleted`:
  - close and remove pane, clear known-session mapping.
- `cleanup()` closes all panes and clears tracking maps.

## Integration

- Integrates with OpenCode session events and server URL from plugin input.
- Uses helper endpoints defined by `src/config` multiplexer settings:
  `type`, `layout`, `main_pane_size`.
- Implementations in `src/multiplexer/tmux` and `src/multiplexer/zellij` are used
  through the shared abstraction.
- Validation coverage:
  - `src/multiplexer/factory.test.ts`
  - `src/multiplexer/session-manager.test.ts`
