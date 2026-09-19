# src/multiplexer/herdr/

## Responsibility

- Implement Herdr-backed pane orchestration for delegated sessions as an alternative to tmux and zellij, running entirely in the TUI client process that displays the parent session.
- Manage pane lifecycle (split, rename, run, close) within the client's current Herdr workspace.
- Keep process cleanup safe and graceful (interrupt + close).

## Design

- `HerdrMultiplexer` in `index.ts` implements `Multiplexer`.
- `findBinary` is a `which/where herdr` probe with a cached path; `HERDR_BIN_PATH` overrides the probe when set.
- `isInsideSession` checks `process.env.HERDR_PANE_ID`; `isAvailable` uses the cached `binaryPath`.
- `spawnPane` requires the parent pane from `HERDR_PANE_ID` (no `--current` fallback; missing → fail closed), splits it in the configured direction, renames the new pane to the agent description, and runs `opencode attach` via `herdr pane run`. Pane IDs are parsed from the newline-delimited JSON of `herdr pane split` (`result.pane.pane_id`).
- `spawnPane` is serialized through an internal mutex so concurrent spawns cannot race the `main-vertical` agent-area tracking; for `main-vertical` the first right-side pane becomes the agent area and later children stack down inside it.
- `listPanesWithTitles` reads `herdr pane list` and maps each pane's `label` for the FR-8 sweep.
- `closePane` sends `ctrl+c` via `herdr pane send_keys`, waits 250ms, then runs `herdr pane close`; exit codes `0` and `1` count as closed.
- `applyLayout` has no Herdr rebalancing API to call: it stores the new layout/direction and clears the tracked agent-area pane so the next spawn starts fresh from the parent pane.
- Layout direction mapping is done by `getPaneDirection`:
  - `main-vertical`, `even-horizontal`, `tiled` → `right`
  - `main-horizontal`, `even-vertical` → `down`

## Flow

- `spawnPane(sessionId, description, serverUrl, directory)`:
  - resolve herdr binary via `getBinary()`
  - require the parent pane from `HERDR_PANE_ID` (missing → `{ success: false, error: 'not_found' }`, no command issued)
  - split the tracked agent area with `down`, or the parent pane with the layout direction, via `herdr pane split <target> --direction <dir> --cwd <dir> --no-focus`
  - parse the JSON output to extract the new pane ID (`result.pane.pane_id`)
  - rename the pane via `herdr pane rename <pane> <desc>` (writes the `label` field)
  - run `opencode attach <url> --session <sessionId> --dir <directory>` via `herdr pane run <pane>`
  - on attach failure, close the orphaned pane and return `{ success: false, error: 'hard' }`
  - return `{ success, paneId }`
- `closePane(paneId)`:
  - `herdr pane send_keys <pane> ctrl+c`
  - wait 250ms
  - `herdr pane close <pane>`; treats exit codes `0` and `1` as successful closure
  - clears the tracked agent-area pane when that pane was the one closed
- `applyLayout` does not rebalance: it resets the direction and agent-area state for subsequent spawns.

## Integration

- Selected when `multiplexerConfig.type === 'herdr'` or auto mode detects `process.env.HERDR_PANE_ID` (after cmux/tmux/zellij in the admission order).
- Consumed by the client lifecycle core (`src/multiplexer/client/lifecycle.ts`) via `src/multiplexer/factory.ts`; the server entry must not import multiplexer modules (invariant I1).
- UI attach command semantics are identical to tmux in argument shape: `opencode attach <url> --session <sessionId> --dir <directory>`, so delegated sessions remain config-agnostic across backends.
