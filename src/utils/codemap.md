# src/utils/

Shared utility modules providing low-level services: TMUX orchestration, environment variables, polling, logging, ZIP extraction, agent variant resolution, and internal agent marker handling.

## Responsibility

- **tmux.ts**: Terminal multiplexer pane lifecycle management—spawning, closing, layout rebalancing, and server health probing for child agent sessions
- **env.ts**: Cross-platform environment variable access supporting Bun and Node.js runtime with empty string filtering
- **internal-initiator.ts**: Marker-based identification for internal agent text parts in MCP protocol communication
- **polling.ts**: Generic polling utility with stability detection and abort signal support for asynchronous condition waiting
- **zip-extractor.ts**: Cross-platform ZIP/TAR extraction supporting Windows (tar, pwsh, powershell) and Unix (unzip)
- **logger.ts**: File-based structured logging to temp directory with timestamp and JSON serialization
- **agent-variant.ts**: Agent name normalization and variant resolution from plugin configuration with non-overriding application
- **index.ts**: Central re-export barrel for all utils

## Design

- **Lazy initialization**: TMUX binary path discovery is deferred and cached after first check
- **Defensive guards**: Empty string filtering on env vars, server availability checks before pane spawns, abort signal propagation in polling
- **Graceful shutdown protocol**: TMUX panes receive SIGINT (Ctrl+C) before termination to allow clean process exit
- **Layout persistence**: Stored config enables rebalancing remaining panes after pane closure
- **Server health probing**: HTTP `/health` endpoint validation with retry logic and result caching
- **Platform detection**: `process.env.TMUX` check for tmux context, `process.platform` for OS-specific extraction strategy
- **Stability threshold**: Polling waits for N consecutive stable results before returning success
- **Non-overriding variant application**: Agent variant is applied only if body doesn't already contain one
- **PowerShell path escaping**: Single quotes escaped as doubled single quotes for Windows archive extraction

## Flow

**tmux.ts**:
- `spawnTmuxPane()` → validate config.enabled → check tmux context → probe server health → discover tmux binary → split pane with `opencode attach <url> --session <id>` → rename pane → apply layout → return paneId
- `closeTmuxPane()` → send Ctrl+C → wait 250ms → kill-pane → reapply layout to rebalance
- `isServerRunning()` → GET `/health` with 3s timeout → retry up to 2 times → cache result

**env.ts**:
- `getEnv(name)` → check `Bun.env` first → fallback to `process.env` → filter empty strings

**internal-initiator.ts**:
- `createInternalAgentTextPart()` → append marker to text
- `hasInternalInitiatorMarker()` → check if part.type === 'text' and contains marker

**polling.ts**:
- `pollUntilStable()` → loop with configurable interval → call fetchFn → check stability predicate → increment stable count on match → reset on failure → return on threshold or timeout
- `delay(ms)` → Promise-wrapped setTimeout

**zip-extractor.ts**:
- `extractZip()` → detect platform → Windows: check build number for tar support, fallback to pwsh/powershell → Unix: use unzip → spawn process → await exit code → throw on failure

**logger.ts**:
- `log()` → construct timestamp → serialize data to JSON → append to temp log file → catch and ignore errors

**agent-variant.ts**:
- `normalizeAgentName()` → trim whitespace → strip @ prefix
- `resolveAgentVariant()` → normalize name → lookup in config.agents → validate type and non-empty → return trimmed variant
- `applyAgentVariant()` → return original body if variant falsy or body already has variant → spread merge variant into body

## Integration

- **Consumers**: Multiplexer/session helpers spawn and close tmux panes, MCP protocol layer checks for internal initiator markers, polling is reused across runtime status checks, ZIP extraction supports plugin updates, and agent variant helpers are applied in the request pipeline
- **Dependencies**: Imports `TmuxConfig`, `TmuxLayout` from `../config/schema`, constants from `../config` (POLL_INTERVAL_MS, MAX_POLL_TIME_MS, STABLE_POLLS_THRESHOLD), logging from `./logger`, `PluginConfig` type from `../config`
- **Exports**: All modules re-exported via `src/utils/index.ts` barrel file
