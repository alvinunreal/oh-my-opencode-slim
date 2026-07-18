# Agent Coding Guidelines

This document provides guidelines for AI agents operating in this repository.

## Project Overview

**oh-my-opencode-slim** - A lightweight agent orchestration plugin for OpenCode, a slimmed-down fork of oh-my-opencode. Built with TypeScript, Bun, and Biome.

## Commands

| Command | Description |
|---------|-------------|
| `bun run build` | Build TypeScript to `dist/` (both index.ts and cli/index.ts) |
| `bun run typecheck` | Run TypeScript type checking without emitting |
| `bun test` | Run all tests with Bun |
| `bun run lint` | Run Biome linter on entire codebase |
| `bun run format` | Format entire codebase with Biome |
| `bun run check` | Run Biome check with auto-fix (lint + format + organize imports) |
| `bun run check:ci` | Run Biome check without auto-fix (CI mode) |
| `bun run dev` | Build and run with OpenCode |

**Running a single test:** Use Bun's test filtering with the `-t` flag:
```bash
bun test -t "test-name-pattern"
```

## Code Style

### General Rules
- **Formatter/Linter:** Biome (configured in `biome.json`)
- **Line width:** 80 characters
- **Indentation:** 2 spaces
- **Line endings:** LF (Unix)
- **Quotes:** Single quotes in JavaScript/TypeScript
- **Trailing commas:** Always enabled

### TypeScript Guidelines
- **Strict mode:** Enabled in `tsconfig.json`
- **No explicit `any`:** Generates a linter warning (disabled for test files)
- **Module resolution:** `bundler` strategy
- **Declarations:** Generate `.d.ts` files in `dist/`

### Imports
- Biome auto-organizes imports on save (`organizeImports: "on"`)
- Let the formatter handle import sorting
- Use path aliases defined in TypeScript configuration if present

### Naming Conventions
- **Variables/functions:** camelCase
- **Classes/interfaces:** PascalCase
- **Constants:** SCREAMING_SNAKE_CASE
- **Files:** kebab-case for most, PascalCase for React components

### Error Handling
- Use typed errors with descriptive messages
- Let errors propagate appropriately rather than catching silently
- Use Zod for runtime validation (already a dependency)

### Git Integration
- Biome integrates with git (VCS enabled)
- Commits should pass `bun run check:ci` before pushing

## Project Structure

```
oh-my-opencode-slim/
├── src/
│   ├── agents/       # Agent factories (orchestrator, explorer, oracle, etc.)
│   ├── cli/          # CLI entry point
│   ├── config/       # Constants, schemas, MCP defaults
│   ├── hooks/        # OpenCode lifecycle hooks
│   ├── mcp/          # MCP server definitions
│   ├── multiplexer/  # Tmux/Zellij pane integration for child sessions
│   ├── skills/       # Skill definitions (included in package publish)
│   ├── tools/        # Tool definitions (webfetch, AST-grep, etc.)
│   └── utils/        # Shared utilities (session, task, logger, env, etc.)
├── dist/             # Built JavaScript and declarations
├── docs/             # User-facing documentation
├── biome.json        # Biome configuration
├── tsconfig.json     # TypeScript configuration
└── package.json      # Project manifest and scripts
```

## Key Dependencies

- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `@opencode-ai/sdk` - OpenCode AI SDK
- `zod` - Runtime validation

## Development Workflow

1. Make code changes
2. Update docs when behavior, commands, configuration, workflows, or user-facing output changes
   - Check `README.md` plus relevant files in `docs/`
   - Keep examples, command snippets, and feature lists in sync with the code
   - If no doc update is needed, explicitly confirm that in your final summary
3. Run `bun run check:ci` to verify linting and formatting
4. Run `bun run typecheck` to verify types
5. Run `bun test` to verify tests pass
6. Commit changes

## Release Workflow

For plugin or Companion releases, follow `docs/release.md`. It documents the
required diff inspection, companion asset workflow, GitHub release creation,
tagging, verification, and npm publish order.

## Prompt Cache Safety

Provider prompt caches are exact byte-prefix matches over the rendered
request (tools → system → messages). Any byte that changes earlier in the
payload invalidates the cache for everything after it, so every request in
the session re-pays full input cost and latency. Past regressions in this
repo all came from hooks rewriting or repositioning earlier conversation
content.

Rules when touching anything that feeds the outgoing payload (hooks,
agent prompts, config constants):

- Inject content only through `src/hooks/cache-safe-injection.ts`:
  deterministic content via `appendTaggedSyntheticPart` (tail of an existing
  message), per-turn volatile content via `stripTaggedContent` +
  `appendTrailingVolatileMessage` (trailing message, end of payload).
- Never mutate or reorder earlier messages, and never let timestamps,
  randomness, or per-request IDs reach content before the payload tail.
- Keep system prompts and tool sets frozen for the lifetime of a session.

Enforcement (all run in `bun test` / CI):

- `src/hooks/cache-safety.property.test.ts` — prefix-stability and
  determinism properties over the real transform pipeline, with a drift
  guard pinned to the composition in `src/index.ts`. New transform steps
  must be added to `src/hooks/cache-safety-harness.test.ts`.
- `src/hooks/cache-payload.snapshot.test.ts` — golden snapshots of injected
  prompt surfaces; failing means the change busts caches once fleet-wide and
  must be updated deliberately via `bun test --update-snapshots`.
- `src/cache-safety-tripwire.test.ts` — bans volatile-input patterns in
  prompt-assembly directories outside a justified allowlist.
- `src/hooks/cache-monitor/` — runtime watchdog that logs a warning when a
  session that was hitting the provider cache reports zero cached tokens.

See `docs/cache-verification.md` for the full verification story.

## Pre-Push Code Review

Before pushing changes to the repository, when makes sense run a code review to catch issues like:
- Duplicate code
- Redundant function calls
- Race conditions
- Logic errors
- Cache safety: prompt-prefix rewrites, volatile content outside the
  trailing zone, or injections bypassing `src/hooks/cache-safe-injection.ts`

## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.

## Debugging Issues

### OpenCode
Log files are written to:
macOS/Linux: ~/.local/share/opencode/log/
Windows: Press WIN+R and paste %USERPROFILE%\.local\share\opencode\log
Log files are named with timestamps (e.g., 2025-01-09T123456.log) and the most recent 10 log files are kept.
You can set the log level with the --log-level command-line option to get more detailed debug information. For example, opencode --log-level DEBUG.

### Plugin
~/.local/share/opencode/log/oh-my-opencode-slim.<timestamp>.log

## Cloned Dependency Source

Read-only dependency source repositories are available under
`.slim/clonedeps/repos/` for inspection. Do not edit these clones.

- `.slim/clonedeps/repos/opencode-ai__opencode/` - `https://github.com/opencode-ai/opencode.git` at `main@73ee493265acf15fcd8caab2bc8cd3bd375b63cb`; inspect `packages/plugin` and `packages/sdk/js` for OpenCode plugin and SDK internals.
- `.slim/clonedeps/repos/opencode/` - `https://github.com/anomalyco/opencode.git` at `dev@356f6841865d68adf6d0123c37357ad50814497a`; inspect `packages/opencode` for latest TypeScript runtime internals and experimental background subagent support.
- `.slim/clonedeps/repos/modelcontextprotocol__typescript-sdk/` - `https://github.com/modelcontextprotocol/typescript-sdk.git` at `v1.29.0@e12cbd7078db388152f6e839abdbe09ba01f3f32`; inspect it for MCP protocol and server integration internals.
- `.slim/clonedeps/repos/agentclientprotocol__agent-client-protocol/` - `https://github.com/agentclientprotocol/agent-client-protocol.git` at `main@8110fde4e8283b4bef1329d1ef7b074fd14cee1e`; inspect it for ACP protocol specification and schema details.

## Agent Operating Context

### Issue tracker

Issues and PRs are tracked on GitHub (`alvinunreal/oh-my-opencode-slim`); external PRs are a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical triage roles map to repo labels via `docs/agents/triage-labels.md`
(e.g. `ready-for-agent` → `good-to-code`; `needs-triage` = unlabeled). Install
the `triage` skill (command in `docs/maintainers.md`). Community preset
submissions use the `community-preset` label (see `docs/maintainers.md`).

### Domain docs

Single-context repo: `CONTEXT.md` and `docs/adr/` at the root, plus `codemap.md`. See `docs/agents/domain.md`.
