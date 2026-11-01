# src/companion/

## Responsibility

Provides the plugin-side state management and distribution integration for the optional animated Companion UI. The native crate, media, builds, and releases live separately in [oh-my-opencode-companion](https://github.com/alvinunreal/oh-my-opencode-companion), with its crate at the repository root.

## Design

The companion system consists of two main components following a **Producer-Consumer** pattern:

- **Producer (manager.ts)**: `CompanionManager` class
  - Listens to OpenCode session lifecycle events (`session.status`, `session.deleted`)
  - Tracks agent activity per session (orchestrator, fixers, etc.)
  - Publishes live session model metadata for active agent tiles; variants are retained only from observed live chat selections, never inferred from static defaults
  - Maintains state in a JSON file at `~/.local/share/opencode/storage/oh-my-opencode-slim/companion-state.json`
  - Uses a stable per-project manager identity within each OpenCode process so multiple project scopes coexist instead of overwriting one `proc_<pid>` row
  - Publishes owner state before allowing the native binary to spawn; a busy state lock is retried asynchronously
  - Prunes state rows whose owning OpenCode process is no longer alive
  - Spawns the companion binary process when enabled
  - Publishes the current/available preset catalog for the active project
  - Maintains a bounded (64) history of previously opened project directories and their last observed preset catalog; never scans disk for repositories
  - Consumes typed preset requests from the native Companion and applies them through the shared preset-switch domain
  - For remembered/offline targets, routes writes only through a live TypeScript manager, checks registered absolute paths, directory accessibility, and invalid JSONC before any preset mutation; returns explicit rejection feedback without changing the relay's config
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

### Unchanged-input Fast Paths

`manager.ts` revalidates state-file identity before using its bounded parsed
memo; mutators work on isolated values and only successful rename publication
becomes the new memo. Native preset requests still poll every 250ms. The
once-per-second config refresh reuses shared config snapshots and skips
unchanged derivation. `status.ts` owns the dependency-free busy/idle normalization
used by the root without eagerly loading Companion machinery.

### State Management

- Uses the shared PID/token lock implementation for `companion-state.json.lock`, including stale-owner recovery instead of an unowned mkdir-only lock
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
   - Publishes a distinct project-scoped session row first, then spawns/joins the singleton companion only after publication succeeds
   - Retries transient state-lock contention without blocking the plugin thread
   - Cleans up stale sessions from dead OpenCode processes on state writes

2. **Agent activity events** (`CompanionManager.onSessionStatus()`)
   - Receives `session.status` events from OpenCode
   - Maps session IDs to agent names via `sessionAgentMap`
   - Updates internal state:
     - `busy` → adds agent to active_agents array
     - `idle` → removes agent from active_agents array
     - Project status reflects all active sessions, with pending input taking priority
    - Flushes state to JSON file

   **Input requests** (`onWaitingInput()` / `onInputResolved()`)
   - Track permissions and questions by session, kind, and request ID
   - Keep `waiting-input` until all pending requests are resolved
   - Drop a session's pending requests when that run terminates or is deleted

3. **Session termination** (`CompanionManager.onSessionDeleted()`)
   - Removes session from active tracking
   - Updates companion display
   - Logical manager disposal retries a contended state removal before returning; process-exit cleanup remains synchronous and best effort

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
   - Startup installs asynchronously without delaying plugin availability, then starts the manager unless its generation was disposed
   - Fetches archive from GitHub releases
   - Validates SHA-256 checksum
   - Extracts tar.gz (Unix) or zip (Windows)
   - Copies binary to installation directory
   - On Windows, moves the previous executable aside before replacement and retries old-image cleanup on later starts
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

- Repository: `alvinunreal/oh-my-opencode-companion`
- Release tag pattern: `companion-v{version}`
- Artifact names: `oh-my-opencode-slim-companion-v{version}-{target}.{tar.gz|zip}`
- The plugin's scheduled/manual manifest-sync workflow hashes all five public
  release archives and opens a plugin-local PR; native releases remain autonomous.
- Offline manifest validation and pinned remote release/hash verification are
  independent release guards; neither needs a local native checkout or native tags.


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
