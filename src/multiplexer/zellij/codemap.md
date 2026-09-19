# src/multiplexer/zellij/

## Responsibility
Implements a Zellij-based multiplexer adapter that creates and manages terminal panes for sub-agent sessions. Runs inside the client process that displays the parent OpenCode session and anchors every child pane to that client's parent pane.

## Design

### Architecture Pattern
- **Adapter Pattern**: Wraps Zellij's CLI actions to implement the Multiplexer interface
- **Stateless placement, cached anchor**: The parent tab is resolved once from the parent pane id and cached after a successful lookup; there is no tab/focus state machine anymore

### Core Components

#### ZellijMultiplexer Class
- Implements `Multiplexer` interface with `type = 'zellij'`
- Manages Zellij binary discovery, availability checks, and version gating
- Single pane-placement behavior: child panes are always created in the tab
  containing the parent pane (no dedicated agents tab, no tab switching, no
  focus save/restore, no first-pane reuse)

#### Version Gating
- `isAvailable()` runs `zellij --version` and requires Zellij >= 0.44.1
- Older releases (or unparsable version output) make `isAvailable()` return
  `false`, so the backend is skipped with an `unavailable` failure
- Required because the same-tab path still uses `new-pane --tab-id` and the
  stable `tab_id` field of `list-panes --json --tab --all`; both only exist
  in 0.44.1+ (`rename-pane -p` / `write-chars -p` are no longer used — they
  retired with the agent tab)

#### Session Management
- **Pane Creation**: `spawnPane()` creates a pane in the parent tab with
  `new-pane --tab-id <parentTab> --direction <dir>`
- **Multi-instance hardening**: every invocation is prefixed with
  `--session <ZELLIJ_SESSION_NAME>` (before `action`) so commands cannot hit
  another zellij session on the same machine
- **Fail-closed anchoring**: missing `ZELLIJ_PANE_ID`, missing
  `ZELLIJ_SESSION_NAME`, or an unresolvable parent tab issues no zellij
  command and returns `{ success: false, error: 'not_found' }`
- **Lifecycle**: implements `closePane()` with graceful Ctrl+C shutdown before
  pane termination, also session-addressed

#### Layout Handling
- Maps `MultiplexerLayout` to Zellij pane directions:
  - `'main-vertical'` → `'right'` (vertical split)
  - `'main-horizontal'` → `'down'` (horizontal split)
  - `'even-horizontal'`, `'even-vertical'`, `'tiled'` → `null` (no direction, Zellij handles tiling)

### Shell Integration
- **Command Construction**: Builds `opencode attach` commands with session, server URL, and directory
- **Pane Naming**: Truncates description to 30 chars for pane titles
- **Shell Safety**: Runs the attach command through `sh -lc`

## Flow

### Spawn (single behavior)
```
1. Plugin loads → ZellijMultiplexer instantiated with layout='main-vertical'
2. spawnPane() guards the client environment:
   - ZELLIJ_SESSION_NAME missing → no command, { success: false, error: 'not_found' }
   - ZELLIJ_PANE_ID missing      → no command, { success: false, error: 'not_found' }
3. isAvailable() resolves the binary and gates on zellij >= 0.44.1
4. getParentTabId() resolves the parent pane's tab from ZELLIJ_PANE_ID via
   list-panes --json --tab --all (cached after the first success)
   - lookup failure → no command, { success: false, error: 'not_found' }
5. new-pane --tab-id <parentTab> [--direction <dir>] --name <title>
   --close-on-exit -- sh -lc '<opencode attach ...>'
   - if the directed split is silently dropped (exit 0, no terminal_* id),
     retry once without --direction (keeps --session/--tab-id)
6. Session completion:
   - closePane() sends Ctrl+C → delay → close-pane, both --session addressed
```

## Integration Points

### Dependencies
- **Zellij**: External terminal multiplexer (binary must be in PATH)
- **Multiplexer Interface**: Implements `src/multiplexer/types.ts::Multiplexer`
- **Config Schema**: Uses `src/config/schema.ts::MultiplexerLayout`
- **Utils**: Uses `src/utils/compat.ts::crossSpawn` for cross-platform process spawning

### Consumers
- **Multiplexer factory**: instantiates ZellijMultiplexer (client process)
- **Client lifecycle**: `src/multiplexer/client/lifecycle.ts` calls `spawnPane`/`closePane`

### Environment
- **ZELLIJ_PANE_ID**: parent pane; detection signal and the anchor used to
  resolve the parent tab
- **ZELLIJ_SESSION_NAME**: explicit `--session` address for every invocation
- **Zellij Actions**: `new-pane`, `list-panes`, `write`, `close-pane` — all
  routed with `--session <name>`; no `new-tab`, `go-to-tab-by-id`,
  `rename-pane`, `write-chars`, `list-tabs`, or `focus-pane`

### Error Handling
- Distinguishable failure reasons: `unavailable` (no binary / old version),
  `not_found` (unresolvable anchor: missing env or failed parent tab lookup),
  `hard` (new-pane failures / exceptions)
- Crowded-split fallback: a `--direction` new-pane that is silently dropped
  (exit 0, no `terminal_*` id) is retried once without the direction hint,
  letting Zellij place the pane in the largest free space of the same tab
- Layout changes are no-op after pane creation (Zellij doesn't support dynamic layout rebalancing)

## Key Implementation Details

### Pane Identity Management
- Zellij pane IDs are strings like "terminal_0", "terminal_1"
- `normalizePaneId()` strips "terminal_" prefix for numeric comparisons
- Tab IDs are numeric strings (e.g., "1", "2")

### State Tracking
- `parentTabId` / `parentTabResolved`: caches the parent tab ID after a
  successful lookup only; failed lookups are retried on the next spawn
- `parentPaneId` / `sessionName`: captured from the client environment at
  construction; spawn/close fail closed when either is absent

### Graceful Shutdown Sequence
```typescript
1. write Ctrl+C to the pane (`action write --pane-id <id>`, --session addressed)
2. 250ms delay for process cleanup
3. close-pane with pane ID (--session addressed)
```

## Testing
- Test file: `src/multiplexer/zellij/index.test.ts`
- Tests cover: detection via `ZELLIJ_PANE_ID`, version gating, same-tab
  placement with no tab commands, explicit `--session` on every argv,
  fail-closed behavior without an anchor, crowded-split fallback, layout
  mapping, and closePane addressing
- Uses mocking for Zellij binary interactions via crossSpawn

## Limitations
- Requires Zellij >= 0.44.1 (older versions make `isAvailable()` return false;
  0.44.0 lacks `new-pane --tab-id`)
- Zellij silently drops `--direction` splits beyond ~4 stacked panes; the
  adapter falls back to an undirected create in the same tab
- Zellij doesn't support exact main pane sizing like tmux
- Layout configuration only affects future pane creation directions
- Requires Zellij to be installed and in PATH
- Pane naming limited to 30 characters due to Zellij constraints
- No dynamic layout rebalancing after initial pane creation
