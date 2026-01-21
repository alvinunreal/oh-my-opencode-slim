# Codebase Cleanup and Simplification Plan (v2) - 2026-01-21

## Goal
Simplify the `oh-my-opencode-slim` codebase by applying coding standards simplification and YAGNI to the *implementation logic*. All existing features (auto-update, hooks, background tasks, tmux) must be preserved but with cleaner, consolidated, and more maintainable code.

## Constraints
- **Preserve all features**: Do not remove any functional capabilities.
- **Maintain interface**: Keep the existing plugin structure and external APIs.
- **Standardization**: Consolidate types, constants, and redundant utility logic.

## Stage 1: Type Consolidation & Agent Refactoring
**Goal**: Resolve circular dependencies and simplify the agent registration system.
- [ ] **1.1 Move Types**: Centralize `AgentDefinition`, `AgentName`, and other core types to `src/agents/types.ts`.
- [ ] **1.2 Data-Driven Agents**: Replace individual agent factory functions (`createExplorerAgent`, etc.) with a single generic factory and a configuration map in `src/agents/index.ts`.
- [ ] **1.3 Prune Agent Logic**: Remove `AGENT_ALIASES` (legacy) and the `fixer` inheritance hack.
- [ ] **1.4 Dynamic Orchestrator Prompt**: Update `ORCHESTRATOR_PROMPT` to derive subagent capabilities from the central config.
- [ ] **1.5 Verify Stage**: Ensure `npm run build` passes and all agents are correctly registered in the plugin. (@orchestrator)

## Stage 2: Feature & Hook Consolidation
**Goal**: Reduce file fragmentation and optimize internal logic without losing features.
- [ ] **2.1 Consolidate Auto-Update**: Merge the 5-file `auto-update-checker` structure into 2 files (`index.ts` and `checker.ts`).
- [ ] **2.2 Centralize Hooks Logic**: Move hardcoded prompts from `phase-reminder` and `post-read-nudge` to `src/config/constants.ts` and simplify their message-parsing logic.
- [ ] **2.3 Optimize Background Polling**: Refactor `BackgroundManager` to use batched session status checks and a Promise-based waiter mechanism for results.
- [ ] **2.4 Clean up Tmux Logic**: Unify constants in `TmuxSessionManager` and align its polling logic with the improved `BackgroundManager` patterns.
- [ ] **2.5 Verify Stage**: Test that auto-update check still runs and background tasks still report results. (@orchestrator)

## Stage 3: Tool & Utility Unification
**Goal**: Remove duplication across tools and consolidate the utility folder structure.
- [ ] **3.1 Unified Binary Downloader**: Create a generic `BinaryDownloader` in `src/shared/` to be used by both `grep` and `ast-grep`.
- [ ] **3.2 Shared Formatters**: Extract common search result formatting (grouping by file) into `src/shared/formatters.ts`.
- [ ] **3.3 Simplify Grep CLI**: Remove the redundant system `grep` fallback, relying solely on `ripgrep`.
- [ ] **3.4 Merge Shared/Utils**: Combine `src/utils/`, `src/tools/shared/`, and `src/shared/` into a single `src/shared/` directory.
- [ ] **3.5 Verify Stage**: Verify `grep` and `ast-grep` tools still function correctly. (@orchestrator)

## Stage 4: Structural De-fragmentation
**Goal**: Collapse small files and finalize the "slim" architecture.
- [ ] **4.1 Collapse Simple Tools**: Merge `index.ts`, `types.ts`, `constants.ts` for simple tools (like `quota`) into single files.
- [ ] **4.2 Prune Config Schema**: Remove unused fields (variant, temperature, etc.) from `src/config/schema.ts` that aren't utilized by the core logic.
- [ ] **4.3 Final YAGNI Sweep**: Scan for any remaining dead code or over-engineered abstractions.
- [ ] **4.4 Verify Stage**: Comprehensive final verification of all plugin features and tools. (@orchestrator)
