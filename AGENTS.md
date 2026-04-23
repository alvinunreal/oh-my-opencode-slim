# Agent Coding Guidelines

This document provides guidelines for AI agents operating in this repository.

## Project Overview

**oh-my-opencode-slim** — An OpenCode plugin that adds specialist-agent orchestration. Built with TypeScript, Bun, and Biome. Not a standalone app; it registers agents, tools, hooks, and MCPs into the OpenCode runtime.

## Commands

| Command | Description |
|---------|-------------|
| `bun run build` | Build plugin + CLI bundles to `dist/`, emit declarations, regenerate config schema |
| `bun run typecheck` | `tsc --noEmit` — type check only |
| `bun test` | Run all tests (root is `./src` via `bunfig.toml`) |
| `bun run check` | Biome check with auto-fix (lint + format + organize imports) |
| `bun run check:ci` | Biome check without auto-fix (CI gate) |
| `bun run dev` | Build then launch OpenCode |
| `bun run generate-schema` | Regenerate `oh-my-opencode-slim.schema.json` from Zod schema |

**Single test:** `bun test -t "test-name-pattern"`
**Single file:** `bun test src/config/loader.test.ts`

### Build internals

The build is a 4-step pipeline (`bun run build`):

1. `build:plugin` — Bun-bundle `src/index.ts` → `dist/index.js` (ESM, Node target)
2. `build:cli` — Bun-bundle `src/cli/index.ts` → `dist/cli/index.js`
3. `tsc --emitDeclarationOnly` — Generate `.d.ts` files into `dist/`
4. `generate-schema` — Produce JSON Schema from the Zod config schema

**Adding a new dependency?** Check `build:plugin`/`build:cli` in `package.json` — packages listed in `--external` are not bundled. New packages that should remain external (native modules, host-provided SDKs) must be added there.

`prepare` script runs `build` automatically on install.

### CI pipeline

CI (`.github/workflows/ci.yml`) runs: `lint → typecheck → test → build` on every push/PR to `main`/`master`. A second job (`package-smoke`) builds and runs `verify:release` + `verify:host-smoke` on both Ubuntu and macOS.

## Development Workflow

1. Make code changes
2. Update docs when behavior, commands, configuration, or user-facing output changes
   - Check `README.md` plus relevant files in `docs/`
   - Keep examples, command snippets, and feature lists in sync with the code
   - If no doc update is needed, explicitly confirm that in your final summary
3. `bun run check:ci` — lint + format gate
4. `bun run typecheck` — type gate
5. `bun test` — test gate
6. Commit changes

## Code Style

- **Formatter/Linter:** Biome (`biome.json`) — single quotes, 2-space indent, 80-char line width, trailing commas, LF endings
- **Strict TypeScript:** `strict: true`, `moduleResolution: "bundler"`, declarations emitted to `dist/`
- **No explicit `any`:** Linter warning in source, allowed in test files (Biome override)
- **Imports:** Biome auto-organizes on check — don't manually sort
- **`zod` v4:** Used for runtime validation and config schema. It is a **peerDependency** (`^4.0.0`), not a regular dep.

## Project Structure

```
src/
├── agents/       # Agent factories (orchestrator, explorer, oracle, designer, fixer, librarian, council, councillor, observer)
├── cli/          # CLI entry point — install, config, presets, skill packaging
├── config/       # Zod config schema, loaders, constants, agent/MCP policy helpers
├── council/      # Council manager (multi-LLM session orchestration and synthesis)
├── hooks/        # OpenCode lifecycle hooks (apply-patch, auto-update, error recovery, todo-continuation, etc.)
├── interview/    # /interview feature — browser-based Q&A flow for spec generation
├── mcp/          # Built-in MCP server definitions (websearch, context7, grep_app)
├── multiplexer/  # Tmux/Zellij pane integration for live session visualization
├── skills/       # Skill payloads shipped at install time (codemap, simplify)
├── tools/        # Tool definitions (ast-grep search/replace, smartfetch, council tool, preset manager)
└── utils/        # Shared utilities (logger, tmux, session helpers, subagent depth tracking)
```

Key entry points:
- `src/index.ts` — Plugin bootstrap and composition root (840+ lines). Wires every subsystem together.
- `src/cli/index.ts` — CLI entry point
- `src/config/schema.ts` — Source-of-truth runtime config schema

## Tmux Session Lifecycle Management

When working with tmux integration, orphaned processes and ghost panes are the primary failure mode.

### Lifecycle

```
session.create() → tmux pane spawned → task runs
  → session goes idle → extract results → session.abort()
    → session.deleted event → tmux pane closed
```

### Key rules

1. **Graceful shutdown** (`src/multiplexer/tmux/`): Always send `C-c` before `kill-pane`, with a short delay
2. **Abort timing** (`src/council/council-manager.ts`): Call `session.abort()` AFTER extracting task results — content is destroyed on abort
3. **Event wiring** (`src/index.ts`): `multiplexerSessionManager.onSessionDeleted()` must stay connected to close panes

### Testing tmux integration

```bash
bun run build
# Configure plugin as file:// in opencode.jsonc
# Launch tasks, then verify no orphans:
ps aux | grep "opencode attach" | grep -v grep
```

## Pre-Push Code Review

Use `/review` before pushing — it catches issues (duplicate code, redundant calls, race conditions) that linter and tests miss. It delegates to a specialized subagent with full file access.

## Repository Map

`codemap.md` in the project root contains a full architectural map. Read it before working on unfamiliar subsystems. Each `src/` subdirectory also has its own `codemap.md`.

## Common Patterns

- Agent prompts are in `src/agents/<name>.ts` — each agent has its own file, prompt overrides come from `.md` files resolved by the config loader
- Custom user agents are defined via `config.agents.<name>` with `prompt` and `orchestratorPrompt` fields
- Hooks are composed in `src/hooks/index.ts` and attached during plugin init
- The `interview/` feature runs a local HTTP server for browser-based spec capture
- Multiplexer backends (tmux, zellij) are selected at runtime via factory pattern in `src/multiplexer/`
- The `apply-patch` hook is a complex pipeline with matching, resolution, and recovery stages — changes there need careful testing
- `bunfig.toml` sets test root to `./src` — tests must live under `src/`
