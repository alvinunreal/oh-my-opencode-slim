# src/companion/

## Responsibility

Provides the optional animated companion UI feature that visualizes agent activity (busy/idle states) as animated GIFs. This is a user-facing visual overlay that runs separately from OpenCode's core orchestration.

## Design

The companion system consists of two main components following a **Producer-Consumer** pattern:

- **Producer (manager.ts)**: `CompanionManager` class
  - Listens to OpenCode session lifecycle events (`session.status`, `session.deleted`)
  - Tracks agent activity per session (orchestrator, fixers, etc.)
  - Maintains state in a JSON file at `~/.local/share/opencode/storage/oh-my-opencode-slim/companion-state.json`
  - Spawns the companion binary process when enabled
  - Implements a locking mechanism for concurrent state writes

- **Consumer (updater.ts)**: Binary installation and update logic
  - Downloads platform-specific companion binary from GitHub releases
  - Validates checksums for security
  - Manages installation metadata and version tracking
  - Provides update checking and installation workflows

### Key Interfaces

```typescript
interface CompanionSession {
  session_id: string;
  cwd: string;
  active_agents: string[];  // Up to 9 agents displayed
  status: 'idle' | 'busy' | 'waiting-input';
  pid: number;
  config?: CompanionConfig;
}
```

### State Management

- Uses a lock file pattern (`companion-state.json.lock`) for concurrent access
- State file contains array of active sessions with their current agent activity
- Binary path determined by:
  - User config (`binaryPath` in companion config)
  - Default location: `~/.local/share/opencode/storage/oh-my-opencode-slim/bin/`

### Binary Distribution

- Platform-specific builds published to GitHub releases
- Supported targets: macOS (x64/arm64), Linux (x64/arm64), Windows (x64)
- SHA-256 checksums validated on download
- Automatic updates when new versions are available

## Flow

### Session Lifecycle Integration

```
OpenCode Session → CompanionManager.onSessionStatus() → Updates state → Spawns companion binary
```

1. **Plugin loads** (`CompanionManager.onLoad()`)
   - Reads user configuration (`enabled`, `position`, `size`, `gifPack`, `loopStyle`, `speed`, `debug`)
   - If enabled, spawns companion binary process with session ID and debug flags
   - Cleans up stale sessions on load

2. **Agent activity events** (`CompanionManager.onSessionStatus()`)
   - Receives `session.status` events from OpenCode
   - Maps session IDs to agent names via `sessionAgentMap`
   - Updates internal state:
     - `busy` → adds agent to active_agents array
     - `idle` → removes agent from active_agents array
     - `waiting-input` → sets status to waiting-input
     - `input-resolved` → returns to busy/idle based on active agents
   - Flushes state to JSON file

3. **Session termination** (`CompanionManager.onSessionDeleted()`)
   - Removes session from active tracking
   - Updates companion display

4. **State persistence** (`CompanionManager.flush()`)
   - Writes to `companion-state.json` with atomic rename
   - Includes session configuration for display preferences

### Binary Installation Flow

```
ensureCompanionVersion() → installCompanionArchive() → extract → validate → install
```

1. **Check current version**
   - Reads existing installation metadata
   - Compares with manifest version using semantic versioning
   - Returns early if up-to-date

2. **Download and install** (if outdated or missing)
   - Fetches archive from GitHub releases
   - Validates SHA-256 checksum
   - Extracts tar.gz (Unix) or zip (Windows)
   - Copies binary to installation directory
   - Writes installation metadata

3. **Error handling**
   - Timeout after 30 seconds for downloads
   - Lock timeout after 2 seconds (with stale lock detection at 5 minutes)
   - Checksum validation prevents corrupted installations
   - Cleanup of temporary files on failure

## Integration

### Consumed By

- **Main plugin** (`src/index.ts`): Initializes `CompanionManager` for each session
- **User configuration** (`src/config/schema.ts`): Validates companion config schema

### Dependencies

- **OpenCode events**: Listens to `session.status` and `session.deleted` lifecycle events
- **File system**: Uses Node.js `fs` for state persistence and binary installation
- **Child processes**: Spawns companion binary as detached process
- **Network**: Downloads companion binaries from GitHub releases


### Configuration Schema

```typescript
interface CompanionConfig {
  enabled: boolean;           // Enable/disable companion UI
  binaryPath?: string;        // Custom binary path override
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  size?: 'small' | 'medium' | 'large';
  gifPack?: 'default';
  loopStyle?: 'classic' | 'smooth';
  speed?: number;
  debug?: boolean;
}
```

### Environment Variables

- `OH_MY_OPENCODE_SLIM_COMPANION_SESSION_ID`: Set when spawning companion binary
- `OH_MY_OPENCODE_SLIM_COMPANION_DEBUG`: Enables debug mode when config.debug is true

### Storage Locations

- **State file**: `~/.local/share/opencode/storage/oh-my-opencode-slim/companion-state.json`
- **Binary**: `~/.local/share/opencode/storage/oh-my-opencode-slim/bin/oh-my-opencode-slim-companion[.exe]`
- **Metadata**: `~/.local/share/opencode/storage/oh-my-opencode-slim/bin/oh-my-opencode-slim-companion.json`

### GitHub Release Artifacts

- Repository: `alvinunreal/oh-my-opencode-slim`
- Release tag pattern: `companion-v{version}`
- Artifact names: `oh-my-opencode-slim-companion-v{version}-{target}.{tar.gz|zip}`


## Error Handling & Edge Cases

- **Unsupported platforms**: Returns `failed` status with clear error message
- **Missing binary**: Logs warning but doesn't crash plugin
- **Checksum mismatch**: Prevents installation of corrupted binaries
- **Concurrent installations**: Uses lock files with stale lock detection
- **Disabled companion**: Gracefully skips all companion operations
- **Custom binary path**: Skips automatic updates when configured

## Testing Considerations

- Mock `session.status` events to verify state updates
- Test binary installation on different platforms
- Verify checksum validation logic
- Test concurrent state writes with lock mechanism
- Validate configuration schema integration