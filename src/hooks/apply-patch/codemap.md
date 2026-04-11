# apply-patch codemap

## Hook responsibility

`src/hooks/apply-patch/` intercepts only the `apply_patch` tool before OpenCode executes it and, when it detects a stale but recoverable patch, rewrites only the canonical old lines so the native runtime can apply it without inventing new changes. If any patch path falls outside `root`/`worktree`, the hook blocks `apply_patch` before native execution.

## Flow

1. `index.ts` keeps the hook always active and calls `rewritePatchText(...)`.
2. `operations.ts` remains a thin internal barrel over the concrete modules.
3. `codec.ts` parses the `*** Begin Patch` / `*** End Patch` format and can serialize it again.
4. `resolution.ts` resolves each chunk against the real file and canonicalizes safe tolerant matches.
5. `matching.ts` implements exact matching and tolerant rescue paths (unicode, trim, prefix/suffix, and a bounded conservative LCS).
6. `patch.ts` remains a compatibility shim; internal code imports the concrete modules.

## Modules

### `types.ts`
- Shared patch-domain types.
- Separates public contracts (`PatchChunk`, `PreparedChange`, etc.) from the logic.

### `codec.ts`
- `normalizeUnicode()` and `stripHeredoc()`.
- `parsePatch()` converts text into hunks, and `parsePatchStrict()` provides the strict validation used by rewrite/prepare.
- `formatPatch()` rebuilds the patch by reusing the lines from `new_lines` byte-for-byte; if an insertion is re-anchored, it also adds the required intact anchor line.

### `matching.ts`
- Exact/unicode/trim comparators.
- `seek()` / `seekMatch()` and `list()` search for sequences.
- `prefix()` / `suffix()` provide edge-based rescue.
- `rescueByPrefixSuffix()` and `rescueByLcs()` recover stale chunks deterministically.

### `resolution.ts`
- `readFileLines()` reads the file as logical lines; `deriveNewContent()` rebuilds it while preserving the detected physical EOL (`LF` or `CRLF`).
- `resolveChunkStart()` uses `change_context` as the initial anchor.
- `locateChunk()` chooses between exact match, canonicalized tolerant match, edge rescue, or LCS rescue.
- `resolveUpdateChunks()` detects overlaps, prepares ordered hits, and handles the special anchored-insertion path for chunks without `old_lines`, including safe EOF canonicalization when the anchor only resolved through tolerant matching.
- `deriveNewContent()` / `deriveNewContentFromText()` and `applyHits()` produce the final content while preserving `LF`/`CRLF` and the physical final-newline state in updates.

### `execution-context.ts`
- `parseValidatedPatch()` centralizes upfront validation.
- Owns the path guard, realpath/stat caches, and the staged file-state machine.
- `createPatchExecutionContext()` is the shared entry point for rewrite/prepare.

### `rewrite.ts`
- `rewritePatchText()` rewrites update chunks when rescue or safe canonicalization happened.
- It performs a global pre-scan of `add`/`delete`/`update`/`move` before rewriting anything.
- `rewritePatch()` validates `Delete File` with the same staged state machine as `preparePatchChanges()`; this makes it fail if the file no longer exists in the prepared context (real missing file, double delete, or delete after a previous move/delete) before delegating to the native runtime.
- `rewritePatch()` also detects when an `Update File` is no longer self-contained because it consumes staged state from an earlier hunk (for example `add -> update`, `move -> update`, or `update -> update`) and collapses that chain into a canonical form that is safe for the native runtime.
- It keeps the merge/minimize/collapse helpers used for dependent update groups.

### `prepared-changes.ts`
- `preparePatchChanges()` converts hunks into filesystem changes while accumulating state per path to support multiple sequential `Update File` hunks on the same file.
- `applyPreparedChanges()` is documented as an internal best-effort rollback helper that consumes the output of `preparePatchChanges()`, not as a universal transactional engine; it also revalidates the basic shape of the legacy array (types/text/normalized absolute paths) and filesystem invariants before touching disk.

### `operations.ts`
- Thin internal facade/barrel that preserves existing imports for the hook, tests, and compatibility shim.

### `patch.ts`
- Thin facade/barrel.
- Re-exports only the stable public API used by the hook and the tests.

## Invariants

- The hook remains always active and has no public config.
- Content provided through `new_lines` is neither normalized nor rewritten; it is only reused byte-for-byte, except for the intact anchor line that may be added for re-anchored insertions.
- Updates preserve the detected physical `EOL` and whether the original file ended with a newline.
- If a path falls outside `root`/`worktree`, the hook blocks `apply_patch` before native execution.
- No new limits, flags, or runtime settings are introduced.
- The scope of this rescue remains limited to `apply_patch`; it does not rewrite `edit` or `write`.
- Errors remain descriptive and keep the `apply_patch verification failed` prefix where it already existed.
- Normal rewriting remains limited to `update` chunks; only dependent chains between hunks may collapse a previous `add` into the equivalent final state to make the patch self-contained again.
- If an exact resolution depends on the staged result of earlier hunks, the patch is no longer considered "intact" and is collapsed into a self-contained form before handoff to native.
- `Delete File` shares the same staged semantics in both rewrite and prepare; an already invalid delete must not reach native.
- Resolved chunks cannot overlap.

## Quick maintenance guide

- Parsing or rendering issue for patches? → `codec.ts`
- Issue locating stale lines? → `matching.ts` and `resolution.ts`
- Issue writing files or moving paths? → `prepared-changes.ts`
- Need to know what the real hook consumes? → `index.ts` and `patch.ts`
