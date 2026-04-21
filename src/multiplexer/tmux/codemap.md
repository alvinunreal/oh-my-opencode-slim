# src/multiplexer/tmux/

## Responsibility

- Provide tmux-specific pane orchestration for attaching OpenCode child sessions to a split pane beside the current pane.
- Handle lifecycle of spawned panes (create, rename, layout rebalancing, graceful close).
- Resolve and cache tmux executable location for repeated operations.

## Design

- `TmuxMultiplexer` in `index.ts` implements `Multiplexer`.
- `findBinary` uses platform command (`which` or `where`) and validates the binary via `-V`.
- `isAvailable` caches `binaryPath` and `hasChecked` to avoid repeated lookups.
- `targetPane` captures `process.env.TMUX_PANE` and is reused as `targetArgs()` for scoped tmux actions.
- Command execution is performed with `crossSpawn` to support both Bun and Node process interfaces.
- `quoteShellArg` provides shell-safe quoting used for directory/URL/session injection in `opencode` commands.

## Flow

- `spawnPane(sessionId, description, serverUrl, directory)`:
  - ensure binary through `getBinary()`
  - build command: `opencode attach <url> --session <sessionId> --dir <directory>`
  - execute `tmux split-window -h -d -P -F '#{pane_id}' ...` with optional `-t <TMUX_PANE>`
  - on success:
    - rename pane with `select-pane -T` using first 30 chars of `description`
    - call `applyLayout(storedLayout, storedMainPaneSize)`.
- `applyLayout(layout, mainPaneSize)`:
  - `select-layout` on current target
  - for `main-*` layouts, update `main-pane-height|width` and re-select layout for deterministic size.
- `closePane(paneId)`:
  - `send-keys -t <pane> C-c`
  - wait 250ms
  - `kill-pane -t <pane>`
  - on success, re-run `applyLayout` to rebalance panes.

## Integration

- Selected when `multiplexerConfig.type === 'tmux'` or auto mode resolves to tmux (`process.env.TMUX`).
- Consumed by `MultiplexerSessionManager` for `session.created` spawn and completion cleanup.
- Uses `ctx.directory` as working directory, OpenCode API URL as `serverUrl`, and session id as `opencode attach --session` target.
