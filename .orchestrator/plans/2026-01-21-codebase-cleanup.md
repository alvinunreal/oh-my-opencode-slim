# Codebase Cleanup & Simplification Plan

**Created:** 2026-01-21
**Goal:** Review, simplify, and clean up the codebase following YAGNI principles before writing tests
**Estimated Effort:** 30-45 hours

---

## Goal & Constraints

### Primary Goals
1. **Remove complexity** - Simplify overly complex functions and classes
2. **Eliminate YAGNI violations** - Remove unused code, over-engineered solutions
3. **Standardize patterns** - Consistent error handling, logging, and coding style
4. **Improve maintainability** - Make code easier to understand and test

### Constraints
- Maintain backward compatibility
- Don't break existing functionality
- Keep changes atomic and verifiable
- Focus on cleanup only (no new features)

---

## Stage 1: Quick Wins (Low Effort, High Impact)

### Tasks

#### 1.1 Remove Commented-Out Code
- [ ] Remove commented code in `cli/install.ts:159-162`
- [ ] Remove commented code in `cli/install.ts:238-240`
- [ ] Search entire codebase for other commented blocks
- [ ] Remove all commented-out code (keep meaningful comments)

#### 1.2 Standardize Logging
- [ ] Replace `console.log()` with `log()` in `cli/install.ts`
- [ ] Replace `console.error()` with `log()` in `cli/index.ts`
- [ ] Replace `console.warn()` with `log()` in `cli/config-manager.ts`
- [ ] Replace `console.log/error()` in `tools/grep/downloader.ts`
- [ ] Replace `console.log/error()` in `tools/ast-grep/downloader.ts`
- [ ] Verify all logging uses the `log()` function from `shared/logger.ts`

#### 1.3 Remove Unused Imports
- [ ] Check `tools/lsp/client.ts` for unused imports
- [ ] Check `tools/lsp/utils.ts` for unused imports
- [ ] Check `cli/config-manager.ts` for unused imports
- [ ] Run TypeScript compiler to find unused imports
- [ ] Remove all unused imports

#### 1.4 Verify Stage 1 Completion
- [ ] Verify stage completion and update plan if necessary (@orchestrator)

---

## Stage 2: Standardize Error Handling

### Tasks

#### 2.1 Define Error Handling Standard
- [ ] Document the chosen error handling pattern (throw errors with context)
- [ ] Create error types if needed (e.g., `ConfigError`, `LSPError`, `ToolError`)
- [ ] Document error handling guidelines in a comment or doc

#### 2.2 Update Error Handling in Tools
- [ ] Update `tools/lsp/client.ts` - Ensure all errors are thrown with context
- [ ] Update `tools/lsp/utils.ts` - Standardize error handling
- [ ] Update `tools/grep/cli.ts` - Change from returning error objects to throwing
- [ ] Update `tools/grep/downloader.ts` - Standardize error handling
- [ ] Update `tools/ast-grep/cli.ts` - Standardize error handling
- [ ] Update `tools/ast-grep/downloader.ts` - Standardize error handling

#### 2.3 Update Error Handling in Other Modules
- [ ] Update `cli/config-manager.ts` - Remove silent catches, throw errors
- [ ] Update `hooks/auto-update-checker/checker.ts` - Remove silent catches
- [ ] Update `utils/tmux.ts` - Standardize error handling
- [ ] Update `tools/background.ts` - Standardize error handling
- [ ] Update `tools/skill/mcp-manager.ts` - Standardize error handling

#### 2.4 Verify Stage 2 Completion
- [ ] Verify stage completion and update plan if necessary (@orchestrator)

---

## Stage 3: Simplify Complex Functions

### Tasks

#### 3.1 Extract LSP Buffer Processing
- [ ] Extract `processBuffer()` from `tools/lsp/client.ts:266-317` to new module
- [ ] Create `tools/lsp/buffer-processor.ts` with extracted logic
- [ ] Update `tools/lsp/client.ts` to use the new module
- [ ] Add JSDoc comments to the new module

#### 3.2 Break Down Background Task Execution
- [ ] Extract session creation logic from `tools/background.ts:140-292`
- [ ] Extract polling logic from `tools/background.ts:217-249`
- [ ] Extract message extraction logic from `tools/background.ts`
- [ ] Create helper functions with clear names
- [ ] Update `executeSync()` to use the new helper functions

#### 3.3 Extract Text Edit Logic
- [ ] Extract `applyTextEditsToFile()` from `tools/lsp/utils.ts:145-179`
- [ ] Create `tools/lsp/text-editor.ts` with extracted logic
- [ ] Update `tools/lsp/utils.ts` to use the new module
- [ ] Add JSDoc comments to the new module

#### 3.4 Simplify Config Manager
- [ ] Extract `MODEL_MAPPINGS` from `cli/config-manager.ts:293-318` to separate file
- [ ] Create `cli/model-mappings.ts` with the constant
- [ ] Simplify provider config logic in `cli/config-manager.ts`
- [ ] Consider using `jsonc-parser` library for JSONC parsing (optional)

#### 3.5 Verify Stage 3 Completion
- [ ] Verify stage completion and update plan if necessary (@orchestrator)

---

## Stage 4: Remove YAGNI Violations

### Tasks

#### 4.1 Evaluate LSP Connection Pooling
- [ ] Review `tools/lsp/client.ts:18-153` - LSPServerManager class
- [ ] Determine if connection pooling is actually needed
- [ ] If not needed, simplify to single connection
- [ ] If needed, document why it's necessary
- [ ] Remove idle timeout cleanup if not needed

#### 4.2 Simplify Skill Template
- [ ] Move hardcoded template from `tools/skill/builtin.ts:20-100` to external file
- [ ] Create `tools/skill/template.md` or similar
- [ ] Update `tools/skill/builtin.ts` to load template from file
- [ ] Consider making template configurable

#### 4.3 Remove Unused Functions
- [ ] Check if `formatSymbolKind()` in `tools/lsp/utils.ts:106-113` is used
- [ ] Check if `formatSeverity()` in `tools/lsp/utils.ts` is used
- [ ] Check if `ensureCliAvailable()` in `tools/ast-grep/cli.ts:224-232` is used
- [ ] Remove unused functions
- [ ] Search for other potentially unused exports

#### 4.4 Consolidate Binary Download Logic
- [ ] Create shared downloader utility in `tools/shared/downloader.ts`
- [ ] Unify tar.gz extraction logic from `tools/grep/downloader.ts`
- [ ] Unify zip extraction logic from `tools/ast-grep/downloader.ts`
- [ ] Standardize error handling in downloader
- [ ] Update both modules to use the shared utility

#### 4.5 Verify Stage 4 Completion
- [ ] Verify stage completion and update plan if necessary (@orchestrator)

---

## Stage 5: Code Quality & Consistency

### Tasks

#### 5.1 Standardize Async Patterns
- [ ] Replace promise chaining with async/await where appropriate
- [ ] Update `tools/lsp/client.ts:334` - Use async/await instead of setTimeout
- [ ] Review all `.then()`/`.catch()` usage
- [ ] Convert to async/await for consistency

#### 5.2 Improve Naming Consistency
- [ ] Review all type names for consistency (PascalCase for types)
- [ ] Review all function names for consistency (camelCase)
- [ ] Add `is` prefix to boolean functions where missing
- [ ] Ensure parameter names follow conventions

#### 5.3 Add Missing JSDoc Comments
- [ ] Add JSDoc to complex functions
- [ ] Add JSDoc to exported functions
- [ ] Add JSDoc to classes and interfaces
- [ ] Document parameters and return types

#### 5.4 Run TypeScript Compiler
- [ ] Run `tsc --noEmit` to check for type errors
- [ ] Fix any type errors found
- [ ] Ensure strict mode compliance

#### 5.5 Verify Stage 5 Completion
- [ ] Verify stage completion and update plan if necessary (@orchestrator)

---

## Stage 6: Final Verification

### Tasks

#### 6.1 Run Existing Tests
- [ ] Run all existing tests to ensure nothing is broken
- [ ] Fix any failing tests
- [ ] Ensure test suite passes

#### 6.2 Manual Testing
- [ ] Test basic plugin functionality
- [ ] Test LSP features
- [ ] Test background tasks
- [ ] Test MCP skills
- [ ] Test CLI commands

#### 6.3 Code Review Checklist
- [ ] All commented code removed
- [ ] All logging uses `log()` function
- [ ] All unused imports removed
- [ ] Error handling is consistent
- [ ] Complex functions extracted
- [ ] YAGNI violations removed
- [ ] Async patterns standardized
- [ ] Naming is consistent
- [ ] JSDoc comments added
- [ ] No TypeScript errors

#### 6.4 Update Documentation
- [ ] Update README if needed
- [ ] Update any inline documentation
- [ ] Document any breaking changes

#### 6.5 Verify Stage 6 Completion
- [ ] Verify stage completion and update plan if necessary (@orchestrator)

---

## Success Criteria

✅ Code is easier to understand and maintain
✅ No commented-out code remains
✅ Logging is consistent throughout
✅ Error handling follows a standard pattern
✅ Complex functions are broken down
✅ YAGNI violations are removed
✅ All existing tests pass
✅ No TypeScript errors
✅ Manual testing confirms functionality

---

## Notes

- This plan focuses on cleanup only - no new features
- Each stage should be verified before moving to the next
- Update this plan as needed based on findings during execution
- Keep changes atomic and testable
- Document any decisions made during the process