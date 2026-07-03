# src/multiplexer/herdr/

## Responsibility

- Implement Herdr-backed pane orchestration for delegated sessions as an alternative to tmux and zellij.
- Manage pane lifecycle (split, rename, run, close) within the current Herdr workspace.
- Keep process cleanup safe and graceful (interrupt + close).

## Design

- `HerdrMultiplexer` in `index.ts` implements `Multiplexer`.
- `findBinary` is a `which/where herdr` probe with cached path.
- `isInsideSession` checks `process.env.HERDR_ENV` or `process.env.HERDR_PANE_ID`; `isAvailable` uses cached `binaryPath`.
- `spawnPane` resolves the parent pane via `HERDR_PANE_ID` or `--current`, splits it in the configured direction, renames the new pane to the agent description, and runs `opencode attach` via `herdr pane run`. Pane IDs are extracted by parsing JSON CLI output from `herdr pane split`.
- `closePane` sends `ctrl+c` via `herdr pane send_keys`, waits briefly, then runs `herdr pane close`.
- `applyLayout` is intentionally a no-op (Herdr does not expose equivalent layout rebalancing APIs).
- Layout direction mapping is done by `getPaneDirection`:
  - `main-vertical`, `even-horizontal`, `tiled` → `right`
  - `main-horizontal`, `even-vertical` → `down`

## Flow

- `spawnPane(sessionId, description, serverUrl, directory)`:
  - resolve herdr binary via `getBinary()`
  - determine parent pane from `HERDR_PANE_ID` env var or `--current`
  - split parent pane via `herdr pane split <parent> --direction <dir>`
  - parse JSON output to extract new pane ID (`new_pane_id`)
  - rename the pane via `herdr pane send_text <pane> \x1b]0;<desc>\x07`
  - run `opencode attach <url> --session <sessionId> --dir <directory>` via `herdr pane run <pane>`
  - return `{ success, paneId }`
- `closePane(paneId)`:
  - `herdr pane send_keys <pane> ctrl+c`
  - wait 250ms
  - `herdr pane close <pane>`; treats exit codes `0` and `1` as successful closure.
- `applyLayout` is a no-op retained for interface compatibility.

## Integration

- Selected when `multiplexerConfig.type === 'herdr'` or auto mode resolves to herdr (`process.env.HERDR_ENV` or `process.env.HERDR_PANE_ID` present).
- Consumed by `MultiplexerSessionManager` as the pane backend in Herdr environments.
- UI attach command semantics are identical to tmux in argument shape: `opencode attach <url> --session <sessionId> --dir <directory>`, so delegated sessions remain config-agnostic across backends.
