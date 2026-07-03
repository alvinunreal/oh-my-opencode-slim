# src/multiplexer/

## Responsibility

Provides a unified abstraction layer for terminal multiplexers (tmux and zellij) to spawn, manage, and close panes for child OpenCode agent sessions. This enables a "multiplexer-assisted" workflow where each child session runs in its own terminal pane, providing better isolation and resource management compared to traditional background processes.

## Design

### Core Abstractions

- **Multiplexer Interface** (`types.ts`): Defines the contract for terminal multiplexer implementations with methods for pane lifecycle management and layout application.
- **Concrete Implementations**:
  - `TmuxMultiplexer`: tmux-specific implementation using `tmux` CLI commands
  - `ZellijMultiplexer`: zellij-specific implementation using zellij plugin API
- **Session Manager** (`session-manager.ts`): Tracks child session lifecycle and coordinates pane operations via event-driven architecture.
- **Factory** (`factory.ts`): Creates appropriate multiplexer instance based on configuration and environment detection.

### Key Interfaces

```typescript
export interface Multiplexer {
  readonly type: 'tmux' | 'zellij';
  isAvailable(): Promise<boolean>;
  isInsideSession(): boolean;
  spawnPane(sessionId: string, description: string, serverUrl: string, directory: string): Promise<PaneResult>;
  closePane(paneId: string): Promise<boolean>;
  applyLayout(layout: MultiplexerLayout, mainPaneSize: number): Promise<void>;
}
```

### State Management

The session manager uses a **shared global state** pattern to coordinate across plugin instances:
- `sessions`: Map of active tracked sessions (sessionId → pane metadata)
- `knownSessions`: Map of sessions that have been created but may not have active panes
- `spawningSessions`: Set of sessions currently being spawned (prevents duplicate spawns)
- `closingSessions`: Map of ongoing close operations (prevents race conditions)
- `deferredIdleCloses`: Set of sessions that should be closed on idle but have running background jobs

### Event-Driven Architecture

The session manager reacts to OpenCode session events:
- `session.created`: Spawns a new pane for the child session
- `session.status`: Handles idle/busy state transitions
- `session.deleted`: Cleans up pane when session is deleted

## Flow

### Session Creation Flow

```
1. OpenCode creates child session → emits 'session.created' event
2. MultiplexerSessionManager.onSessionCreated()
   ├─ Checks if multiplexer is enabled
   ├─ Validates event properties (sessionId, parentId)
   ├─ Checks if session is already tracked or spawning
   ├─ Records session in knownSessions
   ├─ Spawns pane via multiplexer.spawnPane()
   │  ├─ Validates server is running
   │  ├─ Creates new pane with:
   │  │  ├─ Command: opencode attach --session-id <sessionId>
   │  │  ├─ Working directory: project directory
   │  │  └─ Title: session description
   │  └─ Returns paneId
   ├─ Validates pane creation succeeded
   ├─ Records session in sessions map with pane metadata
   └─ Starts polling loop if not already running

3. Multiplexer implementation spawns pane:
   ├─ Tmux: Uses 'tmux new-window' or 'tmux split-window'
   └─ Zellij: Uses zellij plugin API to create new pane
```

### Session Completion Flow

```
1. Child session becomes idle → emits 'session.idle' or 'session.status' event
2. MultiplexerSessionManager.onSessionStatus()
   ├─ Checks if session is tracked
   ├─ If idle:
   │  ├─ Checks for running background jobs
   │  ├─ If background job running: defers close
   │  └─ Otherwise: closes pane via multiplexer.closePane()
   │     ├─ Removes from sessions map
   │     ├─ Calls tmux/zellij kill-pane command
   │     └─ Logs completion
   └─ If busy: respawns pane (same flow as creation)

3. Session deleted → emits 'session.deleted' event
4. MultiplexerSessionManager.onSessionDeleted()
   ├─ Removes from knownSessions
   └─ Closes pane (same flow as idle)
```

### Polling Loop

- Runs every `POLL_INTERVAL_BACKGROUND_MS` (default: 5000ms)
- Fetches session statuses from OpenCode server
- Closes any idle sessions that aren't tracked by this instance
- Stops when no sessions remain

## Integration

### Consumers

- **Main Plugin** (`src/index.ts`): Initializes multiplexer session manager during plugin startup
- **Council Manager** (`src/council/council-manager.ts`): Uses session manager for child session pane management
- **Background Job Board** (`src/utils/background-job-board.ts`): Coordinates with session manager to defer pane closing when background jobs are running

### Dependencies

- **Config Schema** (`src/config/schema.ts`): Provides `MultiplexerConfig` with type, layout, and size settings
- **Logger** (`src/utils/logger.ts`): Logs multiplexer operations for debugging
- **OpenCode Server**: Provides session lifecycle events and status API

### Configuration

```typescript
interface MultiplexerConfig {
  type: 'tmux' | 'zellij' | 'auto' | 'none';
  layout: MultiplexerLayout; // 'tiled' | 'main-horizontal' | 'main-vertical' | 'grid'
  main_pane_size?: number; // Percentage for main pane (0-100)
  zellij_pane_mode?: string; // Zellij-specific pane mode
}
```

### Environment Detection

- **Auto Mode**: Detects multiplexer type from environment variables (`TMUX` or `ZELLIJ`)
- **Availability Check**: Validates multiplexer binary is available before use

## Implementation Details

### Tmux Implementation

- Uses `tmux` CLI commands via `spawn()` utility
- Creates panes with descriptive titles and working directories
- Applies layouts using `tmux select-layout` and `tmux resize-pane`
- Graceful shutdown: sends Ctrl+C before killing pane to allow clean process termination

### Zellij Implementation

- Uses zellij plugin API via `zellij` CLI
- Creates panes with plugin-based OpenCode integration
- Layout management via zellij's built-in layout system
- Session attachment via zellij's pane-specific attach mechanism

### Error Handling

- Server health checks before pane creation
- Graceful degradation when multiplexer is unavailable
- Logging at each lifecycle stage for observability
- State consistency maintained via shared global state with proper locking

## Testing

- Factory tests (`factory.test.ts`): Validates multiplexer creation and configuration
- Session manager tests (`session-manager.test.ts`): Tests event handling and pane lifecycle
- Integration tests verify pane cleanup on session deletion

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Public API exports |
| `types.ts` | Core interfaces and shared utilities |
| `factory.ts` | Multiplexer instance creation |
| `session-manager.ts` | Session lifecycle management |
| `tmux.ts` | tmux-specific implementation |
| `zellij.ts` | zellij-specific implementation |
