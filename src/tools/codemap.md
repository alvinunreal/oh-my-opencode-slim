# src/tools/ Codemap

## Responsibility

The `src/tools/` directory provides the core tool implementations for the omoslim plugin. It exposes three main categories of tools:

1. **Grep** - Fast regex-based content search using ripgrep (with fallback to system grep)
2. **LSP** - Language Server Protocol integration for code intelligence (definition, references, diagnostics, rename)
3. **AST-grep** - AST-aware structural code search and replacement across 25 languages
4. **Background Tasks** - Fire-and-forget agent task management with automatic notification

These tools are consumed by the OpenCode plugin system and exposed to AI agents for code navigation, analysis, and modification tasks.

---

## Design

### Architecture Overview

```
src/tools/
├── index.ts              # Central export point
├── background.ts         # Background task tools
├── grep/                 # Regex search (ripgrep-based)
│   ├── cli.ts           # CLI execution layer
│   ├── tools.ts         # Tool definition
│   ├── types.ts         # TypeScript interfaces
│   ├── utils.ts         # Output formatting
│   ├── constants.ts     # Safety limits & CLI resolution
│   └── downloader.ts    # Binary auto-download
├── lsp/                  # Language Server Protocol
│   ├── client.ts        # LSP client & connection pooling
│   ├── tools.ts         # 4 tool definitions
│   ├── types.ts         # LSP type re-exports
│   ├── utils.ts         # Formatters & workspace edit application
│   ├── config.ts        # Server discovery & language mapping
│   └── constants.ts     # Built-in server configs
└── ast-grep/            # AST-aware search
    ├── cli.ts           # CLI execution layer
    ├── tools.ts         # 2 tool definitions
    ├── types.ts         # TypeScript interfaces
    ├── utils.ts         # Output formatting & hints
    ├── constants.ts     # CLI resolution & environment checks
    └── downloader.ts    # Binary auto-download
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

#### 2. CLI Abstraction Layer
Both `grep/` and `ast-grep/` use a similar CLI execution pattern:
- **cli.ts**: Low-level subprocess spawning with timeout handling
- **tools.ts**: High-level tool definitions that call CLI functions
- **constants.ts**: CLI path resolution with fallback chain
- **downloader.ts**: Binary auto-download for missing dependencies

#### 3. Connection Pooling (LSP)
The LSP module implements a singleton `LSPServerManager` with:
- **Connection pooling**: Reuse LSP clients per workspace root
- **Reference counting**: Track active usage
- **Idle cleanup**: Auto-shutdown after 5 minutes of inactivity
- **Initialization tracking**: Prevent concurrent initialization

#### 4. Safety Limits
All tools enforce strict safety limits:
- **Timeout**: 60s (grep), 300s (ast-grep, LSP)
- **Output size**: 10MB (grep), 1MB (ast-grep)
- **Match limits**: 500 matches (grep), 200 diagnostics/references (LSP)
- **Depth limits**: 20 directories (grep)

#### 5. Error Handling
- Graceful degradation (ripgrep → grep fallback)
- Clear error messages with installation hints
- Timeout handling with process cleanup
- Truncation detection and reporting

---

## Flow

### Grep Tool Flow

```
User Request
    ↓
grep tool (tools.ts)
    ↓
runRg() (cli.ts)
    ↓
resolveGrepCli() (constants.ts)
    ├─→ OpenCode bundled rg
    ├─→ System PATH rg
    ├─→ Cached download
    └─→ System grep (fallback)
    ↓
buildArgs() → Safety flags + user options
    ↓
spawn([cli, ...args]) with timeout
    ↓
parseOutput() → GrepMatch[]
    ↓
formatGrepResult() (utils.ts)
    ↓
Group by file → Return formatted output
```

### LSP Tool Flow

```
User Request (e.g., lsp_goto_definition)
    ↓
Tool definition (tools.ts)
    ↓
withLspClient() (utils.ts)
    ├─→ findServerForExtension() (config.ts)
    │   ├─→ Match extension to BUILTIN_SERVERS
    │   └─→ isServerInstalled() → PATH check
    ├─→ findWorkspaceRoot() → .git, package.json, etc.
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
  ├─→ Register handlers (diagnostics, configuration)
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

### AST-grep Tool Flow

```
User Request (ast_grep_search or ast_grep_replace)
    ↓
Tool definition (tools.ts)
    ↓
runSg() (cli.ts)
    ├─→ getAstGrepPath()
    │   ├─→ Check cached path
    │   ├─→ findSgCliPathSync()
    │   │   ├─→ Cached binary
    │   │   ├─→ @ast-grep/cli package
    │   │   ├─→ Platform-specific package
    │   │   └─→ Homebrew (macOS)
    │   └─→ ensureAstGrepBinary() → download if missing
    └─→ Build args: pattern, lang, rewrite, globs, paths
    ↓
spawn([sg, 'run', '-p', pattern, '--lang', lang, ...])
    ↓
Parse JSON output → CliMatch[]
    ↓
Handle truncation (max_output_bytes, max_matches)
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

### Background Task Flow

```
User Request (background_task)
    ↓
Tool definition (background.ts)
    ↓
manager.launch()
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
    └─→ Return status/result/error
    ↓
User Request (background_cancel)
    ↓
manager.cancel(task_id) or manager.cancel(all)
    └─→ Cancel running tasks only
```

---

## Integration

### Dependencies

#### External Dependencies
- **@opencode-ai/plugin**: Tool definition schema (`tool`, `ToolDefinition`)
- **vscode-jsonrpc**: LSP JSON-RPC protocol implementation
- **vscode-languageserver-protocol**: LSP type definitions
- **bun**: Subprocess spawning (`spawn`), file operations (`Bun.write`)

#### Internal Dependencies
- **src/background**: `BackgroundTaskManager` for background task tools
- **src/config**: `SUBAGENT_NAMES`, `PluginConfig`, `TmuxConfig`
- **src/utils**: `extractZip` for binary extraction

### Consumers

#### Direct Consumers
- **src/index.ts**: Main plugin entry point imports all tools
- **src/cli/index.ts**: CLI entry point may use tools directly

#### Tool Registry
All tools are exported from `src/tools/index.ts`:
```typescript
export { grep } from './grep';
export { ast_grep_search, ast_grep_replace } from './ast-grep';
export {
  lsp_diagnostics,
  lsp_find_references,
  lsp_goto_definition,
  lsp_rename,
  lspManager,
} from './lsp';
export { createBackgroundTools } from './background';
```

### Configuration

#### LSP Server Configuration
- **BUILTIN_SERVERS** (lsp/constants.ts): Pre-configured servers for 12 languages
- **EXT_TO_LANG** (lsp/constants.ts): Extension to language ID mapping
- **LSP_INSTALL_HINTS** (lsp/constants.ts): Installation instructions per server

#### Grep Configuration
- **Safety limits** (grep/constants.ts): Max depth, filesize, count, columns, timeout
- **RG_SAFETY_FLAGS**: `--no-follow`, `--color=never`, `--no-heading`, `--line-number`, `--with-filename`
- **GREP_SAFETY_FLAGS**: `-n`, `-H`, `--color=never`

#### AST-grep Configuration
- **CLI_LANGUAGES** (ast-grep/types.ts): 25 supported languages
- **LANG_EXTENSIONS** (ast-grep/constants.ts): Language to file extension mapping
- **Safety limits**: Timeout (300s), max output (1MB), max matches (500)

### Binary Management

#### Ripgrep (grep/downloader.ts)
- **Version**: 14.1.1
- **Platforms**: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64
- **Install location**: `~/.cache/omoslim/bin/rg` (Linux/macOS), `%LOCALAPPDATA%\omoslim\bin\rg.exe` (Windows)
- **Fallback**: System grep if ripgrep unavailable

#### AST-grep (ast-grep/downloader.ts)
- **Version**: 0.40.0 (synced with @ast-grep/cli package)
- **Platforms**: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64, win32-arm64, win32-ia32
- **Install location**: `~/.cache/omoslim/bin/sg` (Linux/macOS), `%LOCALAPPDATA%\omoslim\bin\sg.exe` (Windows)
- **Fallback**: Manual installation instructions

### Error Handling Integration

All tools follow a consistent error handling pattern:
1. Try-catch around execution
2. Return formatted error messages
3. Include installation hints for missing binaries
4. Graceful degradation (fallback tools)
5. Timeout handling with process cleanup

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
- **background.ts**: Background task management (3 tools: launch, output, cancel)

### grep/
- **index.ts**: Re-exports grep module
- **cli.ts**: `runRg()`, `runRgCount()` - subprocess execution with timeout
- **tools.ts**: `grep` tool definition
- **types.ts**: `GrepMatch`, `GrepResult`, `CountResult`, `GrepOptions`
- **utils.ts**: `formatGrepResult()` - output formatting
- **constants.ts**: Safety limits, `resolveGrepCli()`, `resolveGrepCliWithAutoInstall()`
- **downloader.ts**: `downloadAndInstallRipgrep()`, `getInstalledRipgrepPath()`

### lsp/
- **index.ts**: Re-exports LSP module and types
- **client.ts**: `LSPServerManager` (singleton), `LSPClient` class
- **tools.ts**: 4 tools: `lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics`, `lsp_rename`
- **types.ts**: LSP type re-exports from vscode-languageserver-protocol
- **utils.ts**: `withLspClient()`, formatters, `applyWorkspaceEdit()`
- **config.ts**: `findServerForExtension()`, `getLanguageId()`, `isServerInstalled()`
- **constants.ts**: `BUILTIN_SERVERS`, `EXT_TO_LANG`, `LSP_INSTALL_HINTS`, safety limits

### ast-grep/
- **index.ts**: Re-exports ast-grep module
- **cli.ts**: `runSg()`, `getAstGrepPath()`, `startBackgroundInit()`
- **tools.ts**: 2 tools: `ast_grep_search`, `ast_grep_replace`
- **types.ts**: `CliLanguage`, `CliMatch`, `SgResult`, `CLI_LANGUAGES`
- **utils.ts**: `formatSearchResult()`, `formatReplaceResult()`, `getEmptyResultHint()`
- **constants.ts**: `findSgCliPathSync()`, `checkEnvironment()`, safety limits
- **downloader.ts**: `downloadAstGrep()`, `ensureAstGrepBinary()`, cache management