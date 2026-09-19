# src/multiplexer/tmux/

## Responsibility

Provides a concrete Tmux-based implementation of the Multiplexer interface for managing child session panes within a Tmux session, running entirely in the TUI client process that displays the parent session. Handles pane spawning, graceful shutdown, and layout management for OpenCode's multiplexer system.

## Design

Implements the `Multiplexer` interface contract defined in `src/multiplexer/types.ts` with Tmux-specific semantics:

- **Singleton-like lifecycle**: The `TmuxMultiplexer` class maintains internal state (binary path, layout preferences, pane tracking) but is instantiated per-use-case rather than globally
- **Binary discovery**: Uses `which`/`where` to locate `tmux` executable at runtime with fallback behavior
- **Layout strategy**: Implements debounced layout application to prevent rapid successive layout changes during bursts of pane operations
- **Graceful shutdown protocol**: Sends Ctrl+C signal before pane termination to allow child processes to exit cleanly
- **Pane lifecycle hooks**: Triggers layout rebalancing after pane creation and destruction events
- **Attached-session targeting**: Re-resolves the anchor pane from
  `process.env.TMUX_PANE` at spawn time and explicitly addresses the tmux
  server with `-S <socket>` taken from the first segment of `process.env.TMUX`;
  there is no pane registry and no startup-pane fallback

### Core Abstractions

- `Multiplexer` interface: Defines the contract for pane management across multiplexer backends (tmux, zellij, herdr, kitty, cmux)
- `MultiplexerLayout`: Type representing Tmux layout types ('main-vertical', 'main-horizontal', 'tiled', 'even-horizontal', 'even-vertical')
- `PaneResult`: Return type for pane operations indicating success/failure and pane identifiers

## Flow

### Pane Spawning Flow

```
1. isAvailable() → findBinary() → locate tmux executable
   ├─ Checks platform-specific command (which/where)
   ├─ Verifies tmux version via tmux -V
   └─ Caches result for subsequent calls

2. spawnPane(sessionId, description, serverUrl, directory)
   ├─ Validates tmux binary availability
   ├─ Constructs opencode attach command with quoted arguments
   ├─ Re-resolves socket (TMUX) and anchor (TMUX_PANE); either missing → fail closed
   ├─ Executes: tmux -S <socket> split-window -h -d -P -F '#{pane_id}' -t <anchor> <opencode-cmd>
   ├─ Captures stdout to extract pane_id
   ├─ Renames pane with description via select-pane -T (FR-8 metadata kept intact)
   └─ Schedules layout rebalance via scheduleLayout(anchor)

3. scheduleLayout(anchor) → applyLayoutNow() (debounced 150ms per anchor pane)
   ├─ Replaces any pending timer for the anchor
   ├─ Re-resolves the socket at fire time (missing → skip)
   ├─ Applies stored layout via tmux -S <socket> select-layout -t <anchor>
   ├─ For main-* layouts: sets main-pane-width/height percentage
   └─ Reapplies layout to use new size
```

### Pane Termination Flow

```
1. closePane(paneId)
   ├─ Requires TMUX; missing socket → returns false without issuing a command
   ├─ Sends Ctrl+C to pane: tmux -S <socket> send-keys -t <paneId> 'C-c'
   ├─ Waits 250ms for graceful shutdown
   ├─ Executes: tmux -S <socket> kill-pane -t <paneId>
   └─ Schedules layout rebalance for the anchor this instance split from
```

### Layout Application Flow

```
1. applyLayout(layout, mainPaneSize)
   ├─ Cancels all pending debounced layout timers
   ├─ Stores layout and size preferences
   ├─ Resolves socket (TMUX) and anchor (TMUX_PANE); either missing → skip
   └─ Calls applyLayoutNow() immediately

2. applyLayoutNow(layout, mainPaneSize, socket, targetPane)
   ├─ Executes: tmux -S <socket> select-layout -t <targetPane> <layout>
   ├─ For main-* layouts:
   │  ├─ Sets main-pane-width/main-pane-height option
   │  └─ Reapplies layout to use new size
   └─ Logs success/failure
```

## Integration

### Consumer Dependencies

- **Primary consumer**: `src/multiplexer/client/lifecycle.ts` (through `src/multiplexer/factory.ts`) - creates the adapter per pane operation
- **TUI wiring**: `src/tui.ts` → `src/multiplexer/client/tui-wiring.ts` - the only production wiring point; the server entry (`src/index.ts`) must not import multiplexer modules (invariant I1)
- **Configuration**: `src/config/schema.ts` - Provides the `MultiplexerLayout` type and the `MultiplexerConfig` values

### Provided Services

- **Pane management**: Spawn and close child session panes within Tmux sessions
- **Layout management**: Apply and maintain pane layouts (main-vertical, main-horizontal, tiled, etc.)
- **Session awareness**: Detection is pane-scoped via `process.env.TMUX_PANE`; the tmux server socket comes from `process.env.TMUX`
- **Error handling**: Graceful degradation when tmux is unavailable (returns success: false)

### Environment Requirements

- **Tmux binary**: Must be installed and available in PATH
- **Tmux session**: Operates within an existing Tmux session (detected via TMUX environment variable)
- **OpenCode CLI**: Requires `opencode` command for attach operations

### Error Handling & Recovery

- **Binary not found**: Returns `success: false` from all operations, logs warning
- **Pane already closed**: `kill-pane` failure returns `false`; the lifecycle keeps the record and retries on a later event
- **Layout failures**: Silently ignored with debug logging; maintains last known good state
- **Ctrl+C failure**: Proceeds to kill-pane after timeout regardless of send-keys result

## Testing

- **Test file**: `src/multiplexer/tmux/index.test.ts` - Validates pane spawning, closing, layout application, and binary discovery
- **Mocking**: Uses crossSpawn compatibility layer for process execution
- **Assertions**: Verifies success/failure returns, pane ID extraction, and command execution

## Performance Characteristics

- **Debouncing**: Layout changes are debounced to 150ms to prevent rapid successive commands
- **Binary caching**: Binary discovery is performed once per instance lifecycle
- **Unref timers**: Layout timers are unref'd to prevent event loop blocking
- **Minimal logging**: Debug-level logging only for critical operations and failures

## Configuration

### Runtime Configurable Parameters

- **Layout type**: Default 'main-vertical' via constructor parameter
- **Main pane size**: Default 60% via constructor parameter
- **Target pane**: The client's own `TMUX_PANE`, re-resolved at spawn time;
  missing `TMUX`/`TMUX_PANE` fails closed without issuing a command

### User Configuration

No user-facing configuration required. Tmux binary location and session environment are runtime-detected.

## Error Scenarios & Mitigations

| Scenario | Behavior | Mitigation |
|----------|----------|-----------|
| tmux binary not found | Returns success: false, logs warning | Fallback to other multiplexer or graceful degradation |
| Pane spawn fails | Returns success: false, logs error | Session continues without pane |
| Registered parent pane is stale | n/a (no registry) | Anchor is re-resolved from `TMUX_PANE` on every spawn |
| Layout application fails | Silently ignored, logs debug | Maintains previous layout |
| Pane already closed | Returns false | Lifecycle keeps tracking the pane and retries on a later event |
| Ctrl+C send fails | Proceeds to kill-pane | Ensures pane termination |

## See Also

- `src/multiplexer/types.ts` - Multiplexer interface definition
- `src/config/schema.ts` - Layout type definitions
- `src/multiplexer/client/lifecycle.ts` - Client lifecycle integration
- `src/utils/compat.ts` - Cross-platform process execution
- `src/utils/logger.ts` - Logging infrastructure
