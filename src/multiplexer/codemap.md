# src/multiplexer/

## Responsibility

- Abstract terminal multiplexer integration for delegated session visualization.
- Resolve backend by configuration and environment (`auto`, `tmux`, `zellij`, `none`).
- Coordinate pane lifecycle and fallback cleanup for spawned child sessions.

## Design

- `types.ts` defines the boundary contract:
  - `Multiplexer` (`spawnPane`, `closePane`, `applyLayout`, `isAvailable`, `isInsideSession`).
  - `PaneResult` and `MultiplexerFactory`.
  - `isServerRunning(serverUrl, timeoutMs?, maxAttempts?)` and `getAutoMultiplexerType` helpers.
- `factory.ts` selects concrete implementation in `getMultiplexer(config)`:
  - explicit `tmux`/`zellij` backends
  - `auto` mode using `TMUX` / `ZELLIJ` env detection
  - per-call construction for live environment fidelity
- `session-manager.ts` implements `MultiplexerSessionManager`, with `TmuxSessionManager` as alias for compatibility.
- `index.ts` re-exports manager/factory contracts and concrete `TmuxMultiplexer` / `ZellijMultiplexer` implementations.

### `session-manager.ts`

- Listens to OpenCode events through `src/index.ts` wiring:
  - `session.created`: validate server availability and call `spawnPane`.
  - `session.status`: close child pane when status becomes `idle`.
  - `session.deleted`: close child pane proactively.
- Maintains an in-memory tracked-session map with stale-status timeout fallback.
- Runs optional polling (`POLL_INTERVAL_BACKGROUND_MS`) as a resilience path when status streaming is incomplete.

## Flow

- `src/index.ts` reads multiplexer config, instantiates `MultiplexerSessionManager`, and starts optional startup availability checks.
- Runtime handlers call `onSessionCreated`, `onSessionStatus`, and `onSessionDeleted` on delegated-session events.
- Backend adapters execute pane operations while preserving session mapping and graceful shutdown semantics.

## Integration

- Used by `src/index.ts` for delegated session visualization and cleanup.
- Implementations live in `src/multiplexer/tmux` and `src/multiplexer/zellij`; callers pass `(sessionId, description, serverUrl, directory)` to spawn panes.
- Unit tests in `src/multiplexer/factory.test.ts` and `src/multiplexer/session-manager.test.ts` validate mode selection and lifecycle behavior.
