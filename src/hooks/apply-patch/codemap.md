# src/hooks/apply-patch/

## Responsibility

Implements OpenCode's patch application hook system with fuzzy matching and automatic rescue strategies. This module intercepts `apply_patch` tool invocations, parses custom patch formats, matches patch chunks to file content using multiple comparison strategies, and rewrites patches to apply cleanly across file moves, renames, and content drift.

## Design Patterns

- **Hook Pattern**: Intercepts tool execution via `tool.execute.before` hook to preprocess patches before native application
- **Strategy Pattern**: Multiple rescue strategies (prefix/suffix, LCS) for matching patch chunks to file content
- **Parser Combinator**: Recursive descent parser for custom patch format with strict/permissive modes
- **Visitor Pattern**: Processes patch hunks through resolution pipeline to determine application locations
- **State Machine**: Manages file state (exists/missing) and dependency tracking for file moves and renames

## Design

The module is organized into five cohesive files:

### 1. index.ts (Hook Entry Point)
- Exports `createApplyPatchHook()` factory that returns the `tool.execute.before` hook
- Intercepts `apply_patch` tool calls and delegates to `rewritePatch()`
- Handles error normalization and fail-open/fail-closed behavior
- Logs hook lifecycle events (rewrite, unchanged, skipped, blocked, validation, verification, internal)

### 2. codec.ts (Patch Serialization)
- **Parsing**: `parsePatch()` and `parsePatchStrict()` parse custom patch format with markers `*** Begin Patch`/`*** End Patch`
- **Format**: Supports add/delete/update operations with optional move semantics
- **Normalization**: Unicode normalization (smart quotes, dashes, ellipsis, non-breaking spaces) and line ending normalization
- **Rendering**: `formatPatch()` converts parsed patch objects back to canonical string format
- **Diff Algorithm**: Internal diffMatrix for rendering optimized patch chunks

### 3. matching.ts (Fuzzy Matching Engine)
- **Comparators**: Multiple line comparison strategies (exact, unicode, trim-end, unicode-trim-end, trim, unicode-trim)
- **Prefix/Suffix Rescue**: `rescueByPrefixSuffix()` matches patches by common prefix/suffix patterns
- **LCS Rescue**: `rescueByLcs()` uses longest common subsequence for fuzzy matching when exact lines not found
- **Anchor Resolution**: `resolveUniqueAnchor()` finds insertion points for new content
- **Utilities**: seek, list, prefix, suffix, score for pattern matching and scoring

### 4. resolution.ts (Patch Resolution Engine)
- **File I/O**: `readFileLines()` and `readFileLinesWithEol()` handle platform-specific line endings
- **Chunk Resolution**: `locateChunk()` finds where patch chunks should be applied in files
- **Anchor Handling**: Resolves insertion points for new content using change_context markers
- **Content Application**: `applyHits()` applies resolved patch hits to file content
- **State Management**: Tracks canonical old/new lines, rewrite strategies, and match comparators

### 5. rewrite.ts (Patch Rewriting Pipeline)
- **Dependency Tracking**: Groups patches by file path to handle file moves and multiple operations on same file
- **Chunk Merging**: `minimizeMergedChunk()` and `mergeSameFileUpdateGroupChunks()` merge adjacent/overlapping patch operations
- **Move Support**: Handles file moves by tracking source and destination paths
- **Add/Delete Operations**: Special handling for file creation and deletion
- **Output Generation**: Produces normalized patch text with minimal context preservation

## Flow

### Hook Execution Flow
```
tool.execute.before (apply_patch)
  ↓
index.ts: createApplyPatchHook()
  ↓
rewritePatch()
  ↓
codec.ts: parsePatch()
  ↓
rewrite.ts: rewritePatch() pipeline
  ↓
resolution.ts: resolveUpdateChunks()
  ↓
matching.ts: seekMatch()/rescueByPrefixSuffix()/rescueByLcs()
  ↓
resolution.ts: locateChunk() → applyHits()
  ↓
rewrite.ts: generate rewritten patch
  ↓
index.ts: return modified patchText to hook
```

### Patch Application Flow

1. **Interception**: Hook intercepts `apply_patch` tool call with patch text
2. **Parsing**: Patch is parsed into structured format (hunks with chunks)
3. **Preparation**: File states are prepared (read, normalized line endings)
4. **Resolution**: Each patch chunk is resolved to a location in the target file:
   - Exact match: Direct application
   - Prefix/Suffix rescue: Match by surrounding context
   - LCS rescue: Fuzzy matching using longest common subsequence
   - Anchor insertion: Insert new content at marked locations
5. **Application**: Changes are applied to file content with EOL preservation
6. **Rewriting**: Rewritten patch is formatted and returned to hook
7. **Hook Return**: Modified patch is passed to native apply_patch tool

### Error Handling Flow

- **Blocked Errors**: Outside workspace operations fail open (return unchanged)
- **Validation Errors**: Malformed patches throw with detailed context
- **Verification Errors**: Missing files or ambiguous matches throw with file paths
- **Internal Errors**: Unexpected failures are wrapped in `createApplyPatchInternalError`

## Integration Points

### Consumed By
- **Main Plugin**: `src/index.ts` registers the hook via `createApplyPatchHook(ctx)`
- **CLI**: `src/cli/index.ts` includes the hook in plugin initialization
- **OpenCode**: Hook integrates with `@opencode-ai/plugin` tool execution system

### Dependencies
- **Utils**: `src/utils/logger.ts` for structured logging
- **Errors**: Custom error hierarchy in `./errors.ts` (createApplyPatchInternalError, getApplyPatchErrorDetails, etc.)
- **Types**: Shared type definitions in `./types.ts`

### Runtime Options
The hook accepts `ApplyPatchRuntimeOptions`:
```typescript
{
  prefixSuffix: boolean;  // Enable prefix/suffix rescue strategy
  lcsRescue: boolean;     // Enable LCS (longest common subsequence) rescue
}
```

Default options in hook:
```typescript
const APPLY_PATCH_RESCUE_OPTIONS: ApplyPatchRuntimeOptions = {
  prefixSuffix: true,
  lcsRescue: true,
};
```

### Error Types
- **blocked**: Operations blocked by safety checks (e.g., outside workspace)
- **validation**: Malformed patch format or missing required fields
- **verification**: File not found or ambiguous matches
- **internal**: Unexpected errors during processing

## Key Algorithms

### 1. Prefix/Suffix Rescue Algorithm
```
Input: old_lines[], new_lines[], file_lines[]
1. Compute common prefix length between old and new lines
2. Compute common suffix length after prefix
3. Collect all occurrences of prefix in file
4. For each prefix occurrence, find matching suffix
5. Return first unambiguous match or error on ambiguity
```

### 2. LCS Rescue Algorithm
```
Input: old_lines[], new_lines[], file_lines[]
1. Compute upper bound of shared lines using line frequency
2. Collect candidate start positions where first line matches
3. Score each window using LCS algorithm
4. Select highest scoring unambiguous match
5. Return match or error on ambiguity/low confidence
```

### 3. Patch Minimization Algorithm
```
Input: patch chunk with old_lines and new_lines
1. Trim common prefix from both arrays
2. Trim common suffix from both arrays
3. Preserve change_context if prefix was trimmed
4. Return minimized chunk if it still produces same result
```

## Performance Characteristics

- **Time Complexity**: O(n*m) for LCS rescue where n=old lines, m=new lines
- **Space Complexity**: O(n*m) for LCS scoring matrix
- **Optimizations**:
  - MAX_LCS_CHUNK_LINES (48) limits LCS to small chunks
  - MAX_LCS_CANDIDATES (64) limits candidate windows
  - Early termination on unambiguous matches
  - Prefix/suffix fast path for common cases

## Testing Considerations

The module handles:
- Unicode normalization and comparison
- Line ending preservation (\n vs \r\n)
- File moves and renames
- Empty file handling
- End-of-file markers
- Overlapping patch chunks
- Ambiguous matches
- Error recovery and fail-open behavior

## Configuration

No external configuration required. All behavior is controlled via:
- Runtime options passed to `rewritePatch()`
- Patch format itself (change_context markers, etc.)
- File system state at application time
