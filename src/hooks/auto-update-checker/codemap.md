# src/hooks/auto-update-checker/

## Responsibility

Implements a background auto-update system for oh-my-opencode-slim that:
- Checks for plugin updates when new OpenCode sessions are created
- Validates version compatibility and channel membership (latest, alpha, beta, etc.)
- Prevents major version upgrades automatically (surfaces as manual migration notice)
- Synchronizes bundled skills from updated packages to OpenCode's skills directory
- Provides user notifications via OpenCode TUI toasts

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
| `constants.ts` | Configuration constants and paths | `PACKAGE_NAME`, `NPM_REGISTRY_URL`, `CACHE_DIR` |
| `types.ts` | TypeScript interfaces and types | `AutoUpdateCheckerOptions`, `CompatibleVersionResult`, `PluginEntryInfo` |
| `skill-sync.ts` | Skill synchronization from package updates | `syncBundledSkillsFromPackage()`, atomic staging with rename |

### Version Safety Strategy

The system implements multiple safety checks:

1. **Local Development Detection**: Skips update checks when running from local `file://` paths
2. **Channel Extraction**: Parses version strings to determine channel (latest, alpha, beta, rc, canary, next)
3. **Major Version Blocking**: Prevents auto-updates that cross major versions; surfaces as manual migration notice
4. **Pinned Version Detection**: Respects pinned versions in user configuration
5. **Timeout Protection**: Uses 60-second timeout for `bun install` to prevent stalling OpenCode
6. **Atomic Skill Sync**: Uses staging directories with rename for atomic skill synchronization

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
Action: Run bun install in isolated directory
    ↓
Sync: Bundled skills to OpenCode config/skills/
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
10. If auto-update disabled: Show notification only
11. Prepare package update in cache directory
12. Run bun install with 60s timeout
13. If install succeeds:
    - Sync bundled skills from package
    - Update companion if enabled
    - Show success toast with version diff and changes
14. If install fails: Show error toast
```

### Skill Synchronization Flow (skill-sync.ts)

1. **Source Validation**: Check if source skills directory exists and is valid
2. **Destination Setup**: Create destination skills directory if needed
3. **Entry Processing**: For each skill directory in source:
   - Skip hidden files (starting with `.`)
   - Validate SKILL.md exists
   - Check if destination already exists
   - If exists: Skip and log
   - If not exists: Create staging directory
   - Copy skill files to staging
   - Atomic rename from staging to destination
   - Clean up staging on success or failure
4. **Result Tracking**: Collect installed, skipped, and failed skills

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
| `node:os` | Platform detection for cache paths |
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
- Platform-specific: `~/.cache/opencode/` (Linux/macOS) or `%LOCALAPPDATA%\opencode` (Windows)
- Plugin cache: `node_modules/oh-my-opencode-slim/`
- Package updates are installed to isolated cache directories

## Error Handling & Recovery

### Failure Modes

1. **Network Timeout**: Uses 5s timeout for NPM registry requests
2. **Install Timeout**: Uses 60s timeout for `bun install` to prevent stalling
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
- Auto-update enabled/disabled scenarios
- Network timeout and failure handling
- Skill synchronization (install, skip, failure cases)
- Companion update scenarios
- Toast notification display
