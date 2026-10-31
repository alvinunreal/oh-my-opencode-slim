# src/hooks/apply-patch/

## Purpose

Preflights patch-tool calls before OpenCode's native tool runs: v1's `apply_patch` and v2's native `patch` (same `{ patchText }` input). It validates the patch, guards target paths, simulates hunks against in-memory file state, and rewrites patches when paths or matched content need canonicalization. The hook does not apply or roll back changes on disk.

## Entry point and contract

- `index.ts` exports `createApplyPatchHook(ctx)` for `tool.execute.before`. Only calls with `input.tool === 'apply_patch'` (v1) or `input.tool === 'patch'` (v2 native) and a string `output.args.patchText` are processed; the v2 tool bridge (`src/v2/setup.ts`) forwards the v2 name unchanged.
- Rewrites mutate `output.args.patchText` on the original args object; the hook never replaces `output.args`. Frozen or read-only args pass through unchanged.
- The root is `input.directory || ctx.directory || process.cwd()`; the worktree is `ctx.worktree || root`.
- An unchanged patch keeps the original args and bytes.
- Only an outside-workspace `blocked` error fails open, passing the original patch to the native tool. Validation, verification, and internal errors leave args intact and throw. `errors.ts` supplies `ApplyPatchError` with stable `kind`, `code`, message, and optional cause.

## Pipeline

1. `codec.ts` normalizes heredocs/line endings and parses `*** Begin Patch`/`*** End Patch` with Add, Delete, Update, and optional Move hunks. Like native, it ignores text outside the markers and blank separators; unlike native, it rejects context that would be mistaken for an End Patch marker or chunks after an EOF marker. `formatPatch()` renders canonical patches in linear time. Shared lines inside a replacement are re-emitted as `-x`/`+x` pairs without changing parsed old/new line arrays.
2. `execution-context.ts` parses, resolves and guards all target paths (including move destinations), and simulates add/delete/update hunks in their original order. `simulatePatch()` returns normalized hunks, a paths-normalized flag, and sequential steps; its staged state allows same-file and add/move dependencies without writing files.
3. `resolution.ts` resolves canonical chunks and staged text, preserving source CRLF/final-newline state. It drops unavailable `@@` contexts, retries trailing empty context lines, and uses the active host's append position. `applyHits()` computes the staged result.
4. `matching.ts` searches globally by native comparator level: exact → trim-end → trim → unicode-trim. An EOF-marked occurrence is rejected if native would choose an earlier one. Prefix/suffix rescue uses unicode plus trim-end, never full-trim, and bounds the replaced middle to `2m+4` lines; ambiguous locations fail. LCS rescue is limited to 48 old lines and 64 candidates, needs at least 70% overlap (minimum two lines), requires both borders and rejects tied best matches.
5. `rewrite.ts` canonicalizes tolerant matches, paths and blank separators, merges overlapping ranges, and folds dependent updates only without intervening path interference. `native-update.ts` models the selected host's update and EOF behavior to verify minimized/fallback chunks; non-reproducible fallbacks are rejected. A standalone update retains order, but native verifies hunks against pre-patch files, not staged state.

## Safety and configuration

- The hook has no `ApplyPatchRuntimeOptions`: prefix/suffix and LCS rescue are always enabled. There is no prepared-changes/rollback engine or disk-applying operation in production; the test helper applies simulated steps with plain filesystem calls.
- `errors.ts` also exports `getErrorMessage`, consumed by `src/companion/updater.ts` to report fetch and install failures.
- The preflight checks paths against the real root and worktree before reading; non-regular files are rejected without reading. Missing `@@` context is removed and rewritten when the remaining chunk is resolvable. Ambiguous rescues, unsupported moves, and overlapping chunks fail closed. Only the native patch tool writes files (v1 `apply_patch`, v2 `patch`).
- The only external dependency of the hook beyond OpenCode's plugin context is the shared structured logger (`src/utils/logger.ts`).

## Verification

Run `bun test src/hooks/apply-patch src/cache-safety-tripwire.test.ts`, `bun run typecheck`, and `bunx biome check src/hooks/apply-patch src/cache-safety-tripwire.test.ts`. The tripwire also guards against stale allowlist entries when files are removed.
