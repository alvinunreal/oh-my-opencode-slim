# src/tools/ Codemap

## Responsibility

The `src/tools/` directory provides the core tool implementations for the oh-my-opencode-slim plugin. It exposes three main categories of tools:

1. **AST-grep** - AST-aware structural code search and replacement across 25+ languages
2. **LSP** - Language Server Protocol integration for code intelligence (definition, references, diagnostics, rename)
3. **Background Tasks** - Fire-and-forget agent task management with automatic notification

These tools are consumed by the OpenCode plugin system and exposed to AI agents for code navigation, analysis, and modification tasks.

---

## Design

### Architecture Overview

```
src/tools/
├── index.ts              # Central export point
├── background.ts         # Background task tools (3 tools)
├── ast-grep/
│   ├── cli.ts            # CLI execution, path resolution, binary download
│   ├── index.ts          # Module re-exports
│   ├── types.ts          # TypeScript interfaces (CliLanguage, CliMatch, SgResult)
│   ├── utils.ts          # Output formatting (formatSearchResult, formatReplaceResult)
│   ├── constants.ts      # CLI path resolution, safety limits
│   └── downloader.ts     # Binary auto-download for missing ast-grep
└── lsp/
    ├── client.ts         # LSP client & connection pooling (LSPServerManager singleton)
    ├── config.ts         # Server discovery & language mapping
    ├── constants.ts      # Built-in server configs (45+ servers), extensions, install hints
    ├── index.ts          # Module re-exports
    ├── types.ts          # LSP type re-exports (Diagnostic, Location, WorkspaceEdit, etc.)
    ├── utils.ts          # Formatters & workspace edit application
    ├── config-store.ts   # User LSP config runtime storage
    └── tools.ts          # 4 tool definitions
```

### Key Patterns

#### 1. Tool Definition Pattern
All tools follow the OpenCode plugin tool schema:
```typescript
export const toolName: ToolDefinition = tool({
  description: string,
  args: { /* Zod schema */ },
  execute: async (args, context) => { /* implementation */ }
});
```

#### 2. CLI Abstraction Layer (ast-grep)
The ast-grep module uses a CLI execution pattern:
- **cli.ts**: Low-level subprocess spawning with timeout handling and JSON output parsing
- **constants.ts**: CLI path resolution with fallback chain (cached binary → @ast-grep/cli → platform-specific → Homebrew → download)
- **downloader.ts**: Binary auto-download for missing dependencies
- **utils.ts**: Output formatting and truncation handling

#### 3. Connection Pooling (LSP)
The LSP module implements a singleton `LSPServerManager` with:
- **Connection pooling**: Reuse LSP clients per workspace root (key: `root::serverId`)
- **Reference counting**: Track active usage via `refCount`, increment on acquire, decrement on release
- **Idle cleanup**: Auto-shutdown after 5 minutes of inactivity (check every 60s)
- **Initialization tracking**: Prevent concurrent initialization races via `initPromise`

#### 4. Safety Limits
All tools enforce strict safety limits:
- **Timeout**: 300s (ast-grep, LSP initialization)
- **Output size**: 1MB (ast-grep)
- **Match limits**: 500 matches (ast-grep), 200 diagnostics (LSP), 200 references (LSP)

#### 5. Error Handling
- Clear error messages with installation hints for missing binaries
- Timeout handling with process cleanup
- Truncation detection and reporting with reason codes
- Graceful fallback chains for CLI resolution

---

## Flow

### AST-grep Tool Flow

```
User Request (ast_grep_search or ast_grep_replace)
    ↓
Tool definition (ast-grep/tools.ts)
    ↓
runSg() (cli.ts)
    ├─→ getAstGrepPath()
    │   ├─→ Check cached path
    │   ├─→ findSgCliPathSync()
    │   │   ├─→ Cached binary in ~/.cache
    │   │   ├─→ @ast-grep/cli package
    │   │   ├─→ Platform-specific package (@ast-grep/cli-*)
    │   │   └─→ Homebrew (macOS)
    │   └─→ ensureAstGrepBinary() → download if missing
    └─→ Build args: pattern, lang, rewrite, globs, paths
    ↓
spawn([sg, 'run', '-p', pattern, '--lang', lang, ...])
    ↓
Parse JSON output → CliMatch[]
    ↓
Handle truncation (max_output_bytes, max_matches, timeout)
    ↓
formatSearchResult() / formatReplaceResult() (utils.ts)
    ├─→ Group by file
    ├─→ Truncate long text
    └─→ Add summary
    ↓
Add empty result hints (getEmptyResultHint)
    ↓
Return formatted output
```

### LSP Tool Flow

```
User Request (e.g., lsp_goto_definition)
    ↓
Tool definition (lsp/tools.ts)
    ↓
withLspClient() (utils.ts)
    ├─→ findServerForExtension() (config.ts)
    │   ├─→ Match extension to BUILTIN_SERVERS
    │   ├─→ Merge with user config from config-store
    │   └─→ isServerInstalled() → PATH check
    ├─→ findServerProjectRoot() → server-specific root patterns
    └─→ lspManager.getClient() (client.ts)
        ├─→ Check cache (root::serverId)
        ├─→ If cached: increment refCount, return
        └─→ If new:
            ├─→ new LSPClient(root, server)
            ├─→ client.start() → spawn server
            ├─→ client.initialize() → LSP handshake
            └─→ Store in pool with refCount=1
    ↓
client.definition() / references() / diagnostics() / rename()
    ├─→ openFile() → textDocument/didOpen
    └─→ Send LSP request
    ↓
Format result (formatLocation, formatDiagnostic, etc.)
    ↓
lspManager.releaseClient() → decrement refCount
    ↓
Return formatted output
```

**LSP Client Lifecycle:**
```
start()
  ├─→ spawn(command)
  ├─→ Create JSON-RPC connection (vscode-jsonrpc)
  ├─→ Register handlers (diagnostics, configuration, window)
  └─→ Wait for process to stabilize
    ↓
initialize()
  ├─→ sendRequest('initialize', capabilities)
  └─→ sendNotification('initialized')
    ↓
[Operational phase]
  ├─→ openFile() → textDocument/didOpen
  ├─→ definition() / references() / diagnostics() / rename()
  └─→ Receive notifications (diagnostics)
    ↓
stop()
  ├─→ sendRequest('shutdown')
  ├─→ sendNotification('exit')
  └─→ kill process
```

### Background Task Flow

```
User Request (background_task)
    ↓
Tool definition (background.ts)
    ↓
manager.launch()
    ├─→ Validate agent against delegation rules
    ├─→ Create task with unique ID
    ├─→ Store in BackgroundTaskManager
    └─→ Return task_id immediately (~1ms)
    ↓
[Background execution]
    ├─→ Agent runs independently
    ├─→ Completes with result/error
    └─→ Auto-notify parent session
    ↓
User Request (background_output)
    ↓
manager.getResult(task_id)
    ├─→ If timeout > 0: waitForCompletion()
    └─→ Return status/result/error/duration
    ↓
User Request (background_cancel)
    ↓
manager.cancel(task_id) or manager.cancel(all)
    └─→ Cancel pending/starting/running tasks only
```

---

## Integration

### Dependencies

#### External Dependencies
- **@opencode-ai/plugin**: Tool definition schema (`tool`, `ToolDefinition`)
- **vscode-jsonrpc**: LSP JSON-RPC protocol implementation
- **vscode-languageserver-protocol**: LSP type definitions
- **bun**: Subprocess spawning (`spawn`), file operations (`Bun.write`)
- **which**: PATH resolution for CLI binaries

#### Internal Dependencies
- **src/background**: `BackgroundTaskManager` for background task tools
- **src/config**: `SUBAGENT_NAMES`, `PluginConfig`, `TmuxConfig`
- **src/utils**: `extractZip` for binary extraction
- **src/utils/logger**: Logging utilities

### Consumers

#### Direct Consumers
- **src/index.ts**: Main plugin entry point imports all tools

#### Tool Registry
All tools are exported from `src/tools/index.ts`:
```typescript
export { ast_grep_replace, ast_grep_search } from './ast-grep';
export { createBackgroundTools } from './background';
export {
  lsp_diagnostics,
  lsp_find_references,
  lsp_goto_definition,
  lsp_rename,
  lspManager,
  setUserLspConfig,
} from './lsp';
```

### Configuration

#### LSP Server Configuration
- **BUILTIN_SERVERS** (lsp/constants.ts): Pre-configured servers for 45+ languages
- **LANGUAGE_EXTENSIONS** (lsp/constants.ts): Extension to LSP language ID mapping
- **LSP_INSTALL_HINTS** (lsp/constants.ts): Installation instructions per server
- **NearestRoot** (lsp/constants.ts): Factory for root pattern matching functions

#### User LSP Configuration
- **config-store.ts**: Runtime storage for user-provided LSP config from opencode.json
- Merged at runtime: built-in servers + user config (user config overrides command/extensions/env, root patterns preserved from built-in)
- Can disable servers with `"disabled": true`

#### AST-grep Configuration
- **CLI_LANGUAGES** (ast-grep/types.ts): Supported languages
- **Safety limits**: Timeout (300s), max output (1MB), max matches (500)

### Binary Management

#### AST-grep (ast-grep/downloader.ts)
- **Version**: 0.40.0 (synced with @ast-grep/cli package)
- **Platforms**: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64, win32-arm64, win32-ia32
- **Install location**: `~/.cache/oh-my-opencode-slim/bin/sg` (Linux/macOS), `%LOCALAPPDATA%\oh-my-opencode-slim\bin\sg.exe` (Windows)
- **Fallback chain**: @ast-grep/cli → platform-specific package → Homebrew → download from GitHub

### Performance Considerations

- **Connection pooling**: LSP clients reused across tool calls
- **Idle cleanup**: LSP clients shutdown after 5 minutes inactivity
- **Output truncation**: Prevent memory issues with large outputs
- **Timeout enforcement**: All subprocess operations have timeouts
- **Caching**: CLI paths cached to avoid repeated filesystem checks
- **Background tasks**: Fire-and-forget pattern for long-running operations

---

## File-by-File Summary

### Root Level
- **index.ts**: Central export point for all tools
- **background.ts**: Background task management (3 tools: background_task, background_output, background_cancel)

### ast-grep/
- **index.ts**: Re-exports ast-grep module and types
- **cli.ts**: `runSg()`, `getAstGrepPath()`, `startBackgroundInit()`, `isCliAvailable()`, `ensureCliAvailable()` - CLI execution layer
- **types.ts**: `CliLanguage`, `CliMatch`, `SgResult`, `CLI_LANGUAGES` - TypeScript interfaces
- **utils.ts**: `formatSearchResult()`, `formatReplaceResult()`, `getEmptyResultHint()` - Output formatting
- **constants.ts**: `findSgCliPathSync()`, `getSgCliPath()`, `setSgCliPath()`, `checkEnvironment()`, `formatEnvironmentCheck()`, safety limits
- **downloader.ts**: `downloadAstGrep()`, `ensureAstGrepBinary()`, `getCacheDir()`, `getCachedBinaryPath()` - Binary management

### lsp/
- **index.ts**: Re-exports LSP module, tools, and types
- **client.ts**: `LSPServerManager` (singleton), `LSPClient` class - full connection lifecycle management
- **tools.ts**: 4 tools: `lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics`, `lsp_rename`
- **types.ts**: LSP type re-exports from vscode-languageserver-protocol (`Diagnostic`, `Location`, `WorkspaceEdit`, etc.)
- **utils.ts**: `withLspClient()`, `findServerProjectRoot()`, formatters, `applyWorkspaceEdit()`, `formatApplyResult()`
- **config.ts**: `findServerForExtension()`, `getLanguageId()`, `isServerInstalled()`, `buildMergedServers()`
- **config-store.ts**: `setUserLspConfig()`, `getUserLspConfig()`, `getAllUserLspConfigs()`, `hasUserLspConfig()`
- **constants.ts**: `BUILTIN_SERVERS` (45+ servers), `LANGUAGE_EXTENSIONS`, `LSP_INSTALL_HINTS`, `NearestRoot()`, safety limits
