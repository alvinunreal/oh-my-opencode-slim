# src/multiplexer/herdr/

## Responsibility

- Implement Herdr-backed pane orchestration for delegated sessions as an alternative to tmux and zellij, running entirely in the TUI client process that displays the parent session.
- Manage pane lifecycle (split, rename, run, close) within the client's current Herdr workspace.
- Re-equalize only the agent panes after each spawn/close, leaving the main pane's `main_pane_size` share untouched.
- Keep process cleanup safe and graceful (interrupt + close).

## Design

- `HerdrMultiplexer` in `index.ts` implements `Multiplexer`.
- `layout-equalize.ts` speaks Herdr's socket API one request per connection: `layout.export` returns the tab's binary split tree, then `layout.set_split_ratio` rewrites every agent-only node to `span(first)/(span(first)+span(second))`. `paneSpan` counts panes along the split axis (perpendicular splits take the larger side), and the walker recurses through — but never rewrites — any split whose subtree contains the main pane. Zoomed tabs are skipped; the whole step is best-effort (logged, never thrown). On Windows the socket is a named pipe, so `herdrSocketEndpoint` maps `HERDR_SOCKET_PATH` onto `\\.\pipe\<path>` before connecting.
- `findBinary` is a `which/where herdr` probe with a cached path; `HERDR_BIN_PATH` overrides the probe when set.
- `isInsideSession` checks `process.env.HERDR_PANE_ID`; `isAvailable` uses the cached `binaryPath`.
- `spawnPane` requires the parent pane from `HERDR_PANE_ID` (no `--current` fallback; missing → fail closed), splits it in the configured direction, renames the new pane to the agent description, and runs `opencode attach` via `herdr pane run`. Pane IDs are parsed from the newline-delimited JSON of `herdr pane split` (`result.pane.pane_id`). `pane run` types the command into the pane's own shell, so on Windows the command position is quoted for PowerShell (`& '<path>'`), and every quoted value uses PowerShell escaping (an embedded apostrophe is doubled) because the POSIX `'\''` form is unreadable to PowerShell.
- `spawnPane` is serialized through an internal mutex so concurrent spawns cannot race the `main-*` agent-area tracking; the first parent split becomes the agent area and later children stack inside it — below for `main-vertical`, to the right for `main-horizontal`. A successful parent split also records `mainPaneId` (from `HERDR_PANE_ID`).
- After a successful attach, and after closing a pane this client spawned, `equalizeAgentArea` calls `layout-equalize.ts` with `HERDR_TAB_ID` / `HERDR_SOCKET_PATH`; missing context is skipped silently and failures only log. `multiplexer.equalize_panes` (constructor 4th parameter, default `true`) gates the step before any environment or socket access.
- `listPanesWithTitles` reads `herdr pane list` and maps each pane's `label` for the FR-8 sweep.
- `closePane` sends `ctrl+c` via `herdr pane send_keys`, waits 250ms, then runs `herdr pane close`; exit codes `0` and `1` count as closed.
- Split directions are mapped per layout:
  - `getPaneDirection` (parent → agent area): `main-vertical`, `even-horizontal`, `tiled` → `right`; `main-horizontal`, `even-vertical` → `down`
  - `getStackDirection` (agent area → later children): `main-vertical` → `down`; `main-horizontal` → `right`
- `main_pane_size` `--ratio` is emitted only for parent splits of `main-*` layouts; `even-*` and `tiled` split the parent without a ratio.

## Flow

- `spawnPane(sessionId, description, serverUrl, directory)`:
  - resolve herdr binary via `getBinary()`
  - require the parent pane from `HERDR_PANE_ID` (missing → `{ success: false, error: 'not_found' }`, no command issued)
  - split the tracked agent area with the layout's stack direction (`down` for `main-vertical`, `right` for `main-horizontal`), or the parent pane with the layout direction, via `herdr pane split <target> --direction <dir> --cwd <dir> --no-focus`
  - the parent split carries `--ratio` only for `main-*` layouts when it creates the agent area
  - parse the JSON output to extract the new pane ID (`result.pane.pane_id`)
  - rename the pane via `herdr pane rename <pane> <desc>` (writes the `label` field)
  - run `opencode attach <url> --session <sessionId> --dir <directory>` via `herdr pane run <pane>`
  - on attach failure, close the orphaned pane and return `{ success: false, error: 'hard' }`
  - equalize the agent panes when `equalize_panes` is enabled and `mainPaneId`, `HERDR_TAB_ID`, and `HERDR_SOCKET_PATH` are all present
  - return `{ success, paneId }`
- `closePane(paneId)`:
  - `herdr pane send_keys <pane> ctrl+c`
  - wait 250ms
  - `herdr pane close <pane>`; treats exit codes `0` and `1` as successful closure
  - clears the tracked agent-area pane when that pane was the one closed
  - re-equalizes the agent area when the closed pane was spawned by this client

## Integration

- Selected when `multiplexerConfig.type === 'herdr'` or auto mode detects `process.env.HERDR_PANE_ID` (after cmux/tmux/zellij in the admission order).
- Consumed by the client lifecycle core (`src/multiplexer/client/lifecycle.ts`) via `src/multiplexer/factory.ts`; the server entry must not import multiplexer modules (invariant I1).
- UI attach command semantics are identical to tmux in argument shape: `opencode attach <url> --session <sessionId> --dir <directory>`, so delegated sessions remain config-agnostic across backends.
