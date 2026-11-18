# src/hooks/search-path-guard/

## Responsibility

Validates search paths before host tool execution to prevent ripgrep execution failures. Intercepts `grep` and `glob` tool calls in `tool.execute.before` to ensure:

- Resolved paths exist (ENOTDIR for invalid paths raises actionable errors)
- Missing paths are reported with helpful guidance rather than cryptic "ripgrep execution failed" errors
- Search path resolution expands home and uses `path.resolve` for both tools; glob ignores `"undefined"` and `"null"`
- Invalid paths are blocked before tool execution with clear error messages

The hook operates exclusively on `grep` and `glob` tools to provide precise path validation for search operations while avoiding interference with other tool categories.

## Design

### Core Architecture
- **Hook Factory**: `createSearchPathGuardHook(ctx)` returns `tool.execute.before` handler
- **Path Resolution**: Uses `resolveSearchPath()` to mirror host tool resolution behavior exactly
- **Validation Logic**: Distinguishes ENOENT (report missing) from ENOTDIR (block invalid) and other stat errors (pass-through)

### Key Components
- **resolveSearchPath()**: Implements precise path resolution matching host tool behavior
- **Path Argument Detection**: Extracts `path` argument from tool calls (grep/glob only)
- **Stat Validation**: Performs filesystem checks with specific error handling
- **Error Reporting**: Provides actionable guidance based on error type

### Error Handling Strategy
- **ENOENT**: Reports missing path with verification guidance
- **ENOTDIR**: Blocks invalid search path with clear error message
- **Other stat errors**: Pass through unchanged (permissions, I/O issues)

### Configuration
- **pathOperations**: Injected path utilities for deterministic testing

## Flow

### Hook Execution Flow
```
Tool execution (grep/glob)
    ↓
Tool execute before hook
    ↓
Validate tool type (grep/glob only)
    ↓
Extract path argument from tool args
    ↓
Resolve path using host-appropriate resolution
    ↓
Validate path exists and is accessible
    ├─ ENOENT → report missing path
    ├─ ENOTDIR → block invalid path
    └─ other error → pass through
    ↓
Proceed with original tool execution (success case)
```

### Path Resolution Flow
```
Input: raw path, directory
    ↓
Check if absolute path (return as-is)
    ↓
Expand home or resolve using path.resolve(directory, raw)
    ↓
Return resolved path or null if directory unavailable
```

### Error Reporting Flow
```
Path validation failure
    ↓
Classify error type (ENOENT/ENOTDIR/other)
    ↓
- ENOENT: "Search path does not exist: {resolved} (from '{raw}'). Verify the target path..."
- ENOTDIR: "Search path is invalid: {resolved}... A path component is not a directory..."
- Other: Pass through to host tool (no modification)
```

## Integration

### Consumers
- **Main Plugin** (`src/index.ts`): Registers the hook during plugin initialization
- **Search Tools**: Intercepts `grep` and `glob` tool calls exclusively
- **Host Tools**: Validates paths before ripgrep/glob execution

### Dependencies
- **Node.js**: `fs.statSync` for filesystem validation
- **Path Module**: `node:path` for path resolution utilities
- **Logger**: Structured logging for validation events
- **Plugin SDK**: `PluginInput` type for hook registration

### Configuration Integration
- **Path Operations**: Uses Node's native path operations in production
- **Directory Context**: Falls back gracefully when `ctx.directory` unavailable

### Performance Considerations
- **Early validation**: Only processes grep/glob tools
- **Minimal overhead**: Single stat operation per validation
- **Fast path**: Absolute paths bypass resolution
- **Deterministic behavior**: Injection-friendly for testing

### Observability
- **Logging**: Tracks validation decisions and error classifications
- **Error messages**: Provide actionable guidance for path issues
- **No side effects**: Only blocks invalid paths, never modifies valid ones

## Testing Considerations

Key test scenarios:
- **Path resolution**: Verify grep and glob use resolve and expand home paths
- **Absolute path handling**: Absolute paths bypass resolution, pass through unchanged
- **Missing path reporting**: ENOENT errors generate helpful error messages
- **Invalid path blocking**: ENOTDIR errors raise clear actionable errors
- **Permission errors**: Pass through without modification
