# src/multiplexer/tmux/

## Responsibility

Provides a concrete Tmux-based implementation of the Multiplexer interface for managing child session panes within a Tmux session. Handles pane spawning, graceful shutdown, and layout management for OpenCode's multiplexer system.

## Design

Implements the `Multiplexer` interface contract defined in `src/multiplexer/types.ts` with Tmux-specific semantics:

- **Singleton-like lifecycle**: The `TmuxMultiplexer` class maintains internal state (binary path, layout preferences, pane tracking) but is instantiated per-use-case rather than globally
- **Binary discovery**: Uses `which`/`where` to locate `tmux` executable at runtime with fallback behavior
- **Layout strategy**: Implements debounced layout application to prevent rapid successive layout changes during bursts of pane operations
- **Graceful shutdown protocol**: Sends Ctrl+C signal before pane termination to allow child processes to exit cleanly
- **Pane lifecycle hooks**: Triggers layout rebalancing after pane creation and destruction events

### Core Abstractions

- `Multiplexer` interface: Defines the contract for pane management across multiplexer backends (tmux, zellij)
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
   ├─ Executes: tmux split-window -h -d -P -F '#{pane_id}' <opencode-cmd>
   ├─ Captures stdout to extract pane_id
   ├─ Renames pane with description (truncated to 30 chars)
   └─ Schedules layout rebalance via scheduleLayout()

3. scheduleLayout() → applyLayout() (debounced 150ms)
   ├─ Increments layoutGeneration counter
   ├─ Applies stored layout via tmux select-layout
   ├─ For main-* layouts: sets main-pane-width/height percentage
   └─ Reapplies layout to use new size
```

### Pane Termination Flow

```
1. closePane(paneId)
   ├─ Sends Ctrl+C to pane: tmux send-keys -t <paneId> 'C-c'
   ├─ Waits 250ms for graceful shutdown
   ├─ Executes: tmux kill-pane -t <paneId>
   └─ Schedules layout rebalance via scheduleLayout()
```

### Layout Application Flow

```
1. applyLayout(layout, mainPaneSize)
   ├─ Cancels pending debounced layout if exists
   ├─ Increments layoutGeneration
   └─ Calls applyLayoutNow() immediately

2. applyLayoutNow(layout, mainPaneSize)
   ├─ Stores layout and size preferences
   ├─ Executes: tmux select-layout <layout>
   ├─ For main-* layouts:
   │  ├─ Sets main-pane-width/main-pane-height option
   │  └─ Reapplies layout to use new size
   └─ Logs success/failure
```

## Integration

### Consumer Dependencies

- **Primary consumer**: `src/multiplexer/multiplexer-manager.ts` - Orchestrates multiplexer sessions and delegates pane operations
- **Lifecycle integration**: `src/index.ts` - Plugin initialization wires up multiplexer session handlers
- **Configuration**: `src/multiplexer/config/schema.ts` - Provides `MultiplexerLayout` type and default values

### Provided Services

- **Pane management**: Spawn and close child session panes within Tmux sessions
- **Layout management**: Apply and maintain pane layouts (main-vertical, main-horizontal, tiled, etc.)
- **Session awareness**: Detects Tmux session environment via `process.env.TMUX`
- **Error handling**: Graceful degradation when tmux is unavailable (returns success: false)

### Environment Requirements

- **Tmux binary**: Must be installed and available in PATH
- **Tmux session**: Operates within an existing Tmux session (detected via TMUX environment variable)
- **OpenCode CLI**: Requires `opencode` command for attach operations

### Error Handling & Recovery

- **Binary not found**: Returns `success: false` from all operations, logs warning
- **Pane already closed**: Treated as success (idempotent operation)
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
- **Target pane**: Optional TMUX_PANE environment variable for nested operations

### User Configuration

No user-facing configuration required. Tmux binary location and session environment are runtime-detected.

## Error Scenarios & Mitigations

| Scenario | Behavior | Mitigation |
|----------|----------|-----------|
| tmux binary not found | Returns success: false, logs warning | Fallback to other multiplexer or graceful degradation |
| Pane spawn fails | Returns success: false, logs error | Session continues without pane |
| Layout application fails | Silently ignored, logs debug | Maintains previous layout |
| Pane already closed | Returns false, logs info | Idempotent operation |
| Ctrl+C send fails | Proceeds to kill-pane | Ensures pane termination |

## See Also

- `src/multiplexer/types.ts` - Multiplexer interface definition
- `src/multiplexer/config/schema.ts` - Layout type definitions
- `src/multiplexer/multiplexer-manager.ts` - Session management integration
- `src/utils/compat.ts` - Cross-platform process execution
- `src/utils/logger.ts` - Logging infrastructure