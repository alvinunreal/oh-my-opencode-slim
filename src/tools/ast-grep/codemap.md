# src/tools/ast-grep/

## Responsibility

Provides AST-aware code search and replace capabilities via the ast-grep CLI. This tooling layer enables OpenCode agents to perform precise, language-aware code transformations and queries across the repository using structured AST patterns rather than fragile regex-based matching.

## Design

The implementation follows a layered architecture:

- **Tool Definitions** (`tools.ts`):
  - `ast_grep_search`: Exposes a tool for AST pattern matching with meta-variable support ($VAR, $$$)
  - `ast_grep_replace`: Exposes a tool for AST-aware code rewriting with dry-run capability
  - Both tools validate inputs, run the CLI, format results, and surface output to the user via metadata

- **CLI Integration** (`cli.ts`):
  - `runSg()`: Core function that spawns the ast-grep CLI with proper argument construction, timeout handling, and output parsing
  - Manages CLI availability via lazy initialization (`getAstGrepPath()`, `startBackgroundInit()`)
  - Implements robust error handling, truncation detection, and retry logic for missing binaries
  - Uses `crossSpawn` for cross-platform process spawning

- **Type System** (`types.ts`):
  - Defines `CliLanguage` (25 supported languages) and `CliMatch`/`SgResult` interfaces
  - Provides type safety for CLI communication and result parsing

- **Utilities** (`utils.ts`):
  - `formatSearchResult()`: Formats search results grouped by file with line numbers and truncation awareness
  - `formatReplaceResult()`: Formats replacement results with dry-run indicators and before/after snippets
  - `getEmptyResultHint()`: Provides user guidance when patterns yield no matches (e.g., missing colons in Python)

- **Binary Management** (`downloader.ts`):
  - `ensureAstGrepBinary()`: Downloads platform-specific ast-grep binary on-demand to `~/.cache/oh-my-opencode-slim/bin/`
  - Supports caching, version detection, and platform-specific artifacts
  - Handles permissions and cleanup

- **Environment & Constants** (`constants.ts`):
  - `checkEnvironment()`: Validates CLI availability at startup for early feedback
  - `formatEnvironmentCheck()`: User-friendly status reporting
  - Defines supported languages, default limits (timeout, max output bytes, max matches), and language-to-extension mappings
  - Implements path resolution logic that checks: cached binary → npm package → platform-specific package → Homebrew → PATH

- **Public API** (`index.ts`):
  - Exports built-in tools for OpenCode integration
  - Re-exports types, constants, and CLI utilities for external consumers

## Flow

### Search Flow
1. Agent invokes `ast_grep_search` tool with pattern, language, optional paths/globs/context
2. Tool validates inputs and calls `runSg()` with appropriate arguments
3. `runSg()` ensures CLI availability (downloads if needed), constructs CLI args:
   - `-p <pattern> --lang <lang> --json=compact`
   - Optional: `-r <rewrite>` (for replace), `-C <context>`, `--globs <glob>`, paths
4. CLI executes, returns JSON output (compact format)
5. `runSg()` parses output, handles truncation (max bytes/max matches), and returns `SgResult`
6. Tool formats results via `formatSearchResult()` and surfaces to user via metadata
7. If no matches, `getEmptyResultHint()` may provide user guidance

### Replace Flow
1. Agent invokes `ast_grep_replace` with pattern, rewrite, language, dry-run flag
2. Tool calls `runSg()` with `updateAll: !dryRun` to enable actual file writes
3. CLI performs AST-aware rewrites and returns matches with `replacement` field
4. Tool formats results with `[DRY RUN]` or `[APPLIED]` indicators and before/after snippets
5. Output is surfaced to user via metadata

### Binary Availability Flow
1. On first use, `getAstGrepPath()` triggers background initialization via `startBackgroundInit()`
2. If cached binary exists and is valid, use it
3. Else, download platform-specific binary via `ensureAstGrepBinary()`
4. Fallback to npm package or system-installed binary if available
5. Path is cached in `resolvedCliPath` to avoid repeated lookups

## Integration

- **Consumed by**: OpenCode plugin system via `@opencode-ai/plugin` tool registration
- **Depends on**:
  - `@ast-grep/cli` (for fallback binary resolution)
  - `crossSpawn` utility for cross-platform process handling
  - `extractZip` utility for binary extraction
- **Exposes to agents**:
  - `ast_grep_search` tool for pattern matching
  - `ast_grep_replace` tool for code transformations
- **Used in**: Agent implementations and skill systems requiring precise code analysis

## Usage Examples

```typescript
// Search for all console.log calls in TypeScript files
@fixer search for console.log calls in TypeScript files

// Replace arrow functions with regular functions
@fixer replace arrow functions with regular functions
```

See tool definitions in `tools.ts` for full argument schemas and examples.
