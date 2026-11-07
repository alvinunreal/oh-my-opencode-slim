# src/hooks/auto-update-checker/

## Responsibility

Implements the v1 background update checker for oh-my-opencode-slim:
- Checks for plugin updates when new OpenCode sessions are created
- Validates version compatibility and channel membership (latest, alpha, beta, etc.)
- Prevents major version upgrades automatically (surfaces as manual migration notice)
- Provides user notifications via OpenCode TUI toasts

V2 uses host package management and the Slim TUI notice instead. Bundled skills
load from the installed package through the host, not a copy/sync module.

## Design

### Architecture Pattern: Observer Hook

The folder implements an **OpenCode plugin hook** that observes the `session.created` event and triggers background update checks. This follows the Observer pattern where:
- The hook subscribes to OpenCode lifecycle events
- Update checks run asynchronously without blocking session creation
- Results are communicated via toast notifications

### Core Modules

| Module | Purpose | Key Abstractions |
|--------|---------|------------------|
| `index.ts` | Main hook factory and update orchestrator | `createAutoUpdateCheckerHook()`, `runBackgroundUpdateCheck()` |
| `checker.ts` | Version checking and compatibility logic | `getLatestCompatibleVersion()`, `extractChannel()`, version parsing and comparison |
| `cache.ts` | Install-dir resolution, staging/publish, cross-process install lock | `resolveInstallContext()`, `preparePackageUpdate()`, `publishPackageUpdate()`, `acquirePackageUpdateLock()` |
| `constants.ts` | Configuration constants and paths | `PACKAGE_NAME`, `NPM_REGISTRY_URL`, `CACHE_DIR` |
| `types.ts` | TypeScript interfaces and types | `AutoUpdateCheckerOptions`, `CompatibleVersionResult`, `PluginEntryInfo` |

### Version Safety Strategy

The system implements multiple safety checks:

1. **Local Development Detection**: Skips update checks when running from local `file://` paths
2. **Channel Extraction**: Parses version strings to determine channel (latest, alpha, beta, rc, canary, next)
3. **Major Version Blocking**: Prevents auto-updates that cross major versions; surfaces as manual migration notice
4. **Pinned Version Detection**: Respects pinned versions in user configuration
5. **Timeout Protection**: Uses a 300-second timeout for the package-manager install (OpenCode's embedded bun, bun, or npm) to prevent stalling OpenCode

### Data Flow

```
OpenCode Session Created
    ↓
Hook: session.created → createAutoUpdateCheckerHook()
    ↓
Check: Local dev mode? → Skip if true
    ↓
Fetch: Current version (cached or pinned)
    ↓
Parse: Extract channel from version
    ↓
Query: NPM registry for latest compatible version
    ↓
Compare: Current vs Latest (with major version blocking)
    ↓
Decision: Update available? → No: Log and exit
    ↓
Decision: Pinned? → Yes: Notify user
    ↓
Decision: Auto-update enabled? → No: Notify user
    ↓
Action: Prepare package update (download + extract)
    ↓
Action: Run package-manager install (OpenCode's embedded bun, bun, or npm) in isolated directory
    ↓
Sync: Companion update (if enabled)
    ↓
Notify: Success/failure via OpenCode TUI toast
```

## Flow

### Hook Initialization Flow

1. **Plugin Registration**: The hook is registered by the main plugin (`src/index.ts`) during plugin initialization
2. **Event Subscription**: Hook subscribes to `session.created` OpenCode event
3. **Single Execution**: Uses `hasChecked` flag to ensure only one background check per plugin load
4. **Parent Session Check**: Skips checks for child sessions (only runs for top-level sessions)
5. **Asynchronous Execution**: Uses `setTimeout(async () => {...}, 0)` to run in background without blocking

### Update Check Flow

```typescript
// In index.ts:runBackgroundUpdateCheck()
1. Resolve plugin entry from user config (pinned or latest)
2. Get cached version or pinned version
3. Extract channel from version string
4. Fetch latest compatible version from NPM registry
5. Check for major version blocking
6. If blocked: Show major upgrade toast with migration instructions
7. If unparseable version: Show notification and skip auto-update
8. If current == latest: Log and exit
9. If pinned: Show pinned version notification
10. Acquire the cross-process install lock for the target install dir
    (PID-guarded dir lock, async wait up to install timeout + slack);
    skip quietly on timeout
12. Under the lock: re-verify the target install dir; if another process
    already installed the version, redirect installer-managed configs
    (surfacing redirect errors) and show the restart toast
13. Prepare package update in cache directory
14. Run package-manager install (OpenCode's embedded bun, bun, or npm) with 300s timeout
15. Release the install lock (finally)
16. If install succeeds:
    - Update companion if enabled
    - Show success toast with version diff and changes
17. If install fails: Show error toast
```

## Integration

### Consumers

- **Primary Consumer**: Main plugin (`src/index.ts`) - registers the auto-update hook during plugin initialization
- **Secondary Consumers**: 
  - `src/companion/updater.ts` - companion version management
  - OpenCode TUI - toast notifications

### Dependencies

| Dependency | Purpose |
|------------|---------|
| `@opencode-ai/plugin` | OpenCode plugin SDK types |
| `@opencode-ai/sdk` | OpenCode AI SDK |
| `node:fs`, `node:path` | File system operations |
| `node:os` | Home-directory fallback for the cache path |
| External: NPM registry | Version lookup and compatibility checking |

### Configuration Integration

The system reads from OpenCode configuration files:
- User config: `~/.config/opencode/opencode.json`
- User config (JSONC): `~/.config/opencode/opencode.jsonc`
- Local config: `.opencode/opencode.json` or `.opencode/opencode.jsonc` in plugin directory

### Event Integration

- **Event Type**: `session.created`
- **Event Source**: OpenCode plugin lifecycle
- **Event Properties**: Checks for `parentID` to avoid duplicate checks in child sessions

### Cache Integration

Uses OpenCode's plugin cache directory:
- `XDG_CACHE_HOME` (when set) or `~/.cache`, then `opencode`, on every platform
- Plugin cache: `node_modules/oh-my-opencode-slim/`
- Package updates are installed to isolated cache directories

## Error Handling & Recovery

### Failure Modes

1. **Network Timeout**: Uses 5s timeout for NPM registry requests
2. **Install Timeout**: Uses 300s timeout for the package-manager install to prevent stalling
3. **Version Parsing**: Handles unparseable versions gracefully (shows notification)
4. **File Operations**: Atomic operations with staging directories prevent partial updates
5. **Concurrent Access**: Uses memoization (`cachedPackageVersion`) to avoid repeated file reads

### Recovery Strategies

- **Retry on Restart**: Companion updates that fail will retry on next OpenCode restart
- **Atomic Operations**: Skill sync uses staging + rename for atomic updates
- **Graceful Degradation**: If auto-update fails, shows error toast but doesn't crash OpenCode
- **Local Dev Fallback**: Local development mode skips all update checks

## Performance Considerations

- **Background Execution**: All update checks run asynchronously after session creation
- **Timeout Protection**: Prevents network or install operations from stalling OpenCode
- **Memoization**: Cached version lookups avoid repeated file system operations
- **Isolated Installs**: Updates run in isolated cache directories to avoid conflicts
- **Single Execution**: Hook ensures only one background check per plugin load

## Testing Considerations

Key test scenarios:
- Local development mode detection
- Version parsing and comparison
- Channel extraction (latest, alpha, beta, rc, canary, next)
- Major version blocking
- Pinned version handling
- Outer feature-gate cold disable (no construction when updates are off)
- Network timeout and failure handling
- Skill synchronization (install, skip, failure cases)
- Companion update scenarios
- Toast notification display
