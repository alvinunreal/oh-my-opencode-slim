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
│   ├── council/      # Council manager (multi-LLM session orchestration)
│   ├── hooks/        # OpenCode lifecycle hooks
│   ├── mcp/          # MCP server definitions
│   ├── multiplexer/  # Tmux/Zellij pane integration for child sessions
│   ├── skills/       # Skill definitions (included in package publish)
│   ├── tools/        # Tool definitions (council, webfetch, AST-grep, etc.)
│   └── utils/        # Shared utilities (tmux, session helpers)
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

## Tmux Session Lifecycle Management

When working with tmux integration, understanding the session lifecycle is crucial for preventing orphaned processes and ghost panes.

### Session Lifecycle Flow

```
Task Launch:
  session.create() → tmux pane spawned → task runs

Task Completes Normally:
  session.status (idle) → extract results → session.abort()
  → session.deleted event → tmux pane closed

Task Cancelled:
  cancel() → session.abort() → session.deleted event
  → tmux pane closed

Session Deleted Externally:
  session.deleted event → task cleanup → tmux pane closed
```

### Key Implementation Details

**1. Graceful Shutdown (src/utils/tmux.ts)**
```typescript
// Always send Ctrl+C before killing pane
spawn([tmux, "send-keys", "-t", paneId, "C-c"])
await delay(250)
spawn([tmux, "kill-pane", "-t", paneId])
```

**2. Session Abort Timing (src/council/council-manager.ts)**
- Call `session.abort()` AFTER extracting task results
- This ensures content is preserved before session termination
- Triggers `session.deleted` event for cleanup

**3. Event Handlers (src/index.ts)**
The multiplexer session handler must stay wired up:
- `multiplexerSessionManager.onSessionDeleted()` - closes tmux/zellij panes

### Testing Tmux Integration

After making changes to session management:

```bash
# 1. Build the plugin
bun run build

# 2. Run from local fork (in ~/.config/opencode/opencode.jsonc):
# "plugin": ["file:///path/to/oh-my-opencode-slim"]

# 3. Launch test tasks
@explorer count files in src/
@librarian search for Bun documentation

# 4. Verify no orphans
ps aux | grep "opencode attach" | grep -v grep
# Should return 0 processes after tasks complete
```

### Common Issues

**Ghost panes remaining open:**
- Check that `session.abort()` is called after result extraction
- Verify `session.deleted` handler is wired in src/index.ts

**Orphaned opencode attach processes:**
- Ensure graceful shutdown sends Ctrl+C before kill-pane
- Check that tmux pane closes before process termination

## Pre-Push Code Review

Before pushing changes to the repository, always run a code review to catch issues like:
- Duplicate code
- Redundant function calls
- Race conditions
- Logic errors

### Using `/review` Command (Recommended)

OpenCode has a built-in `/review` command that automatically performs comprehensive code reviews:

```bash
# Review uncommitted changes (default)
/review

# Review specific commit
/review <commit-hash>

# Review branch comparison
/review <branch-name>

# Review PR
/review <pr-url-or-number>
```

**Why use `/review` instead of asking @oracle manually?**
- Standardized review process with consistent focus areas (bugs, structure, performance)
- Automatically handles git operations (diff, status, etc.)
- Context-aware: reads full files and convention files (AGENTS.md, etc.)
- Delegates to specialized @build subagent with proper permissions
- Provides actionable, matter-of-fact feedback

### Workflow Before Pushing

1. **Make your changes**
   ```bash
   # ... edit files ...
   ```

2. **Stage changes**
   ```bash
   git add .
   ```

3. **Run code review**
   ```
   /review
   ```

4. **Address any issues found**

5. **Run checks**
   ```bash
   bun run check:ci
   bun test
   ```

6. **Commit and push**
   ```bash
   git commit -m "..."
   git push origin <branch>
   ```

**Note:** The `/review` command found issues in our PR #127 (duplicate code, redundant abort calls) that neither linter nor tests caught. Always use it before pushing!

## Common Patterns

- This is an OpenCode plugin - most functionality lives in `src/`
- The CLI entry point is `src/cli/index.ts`
- The main plugin export is `src/index.ts`
- Agent factories are in `src/agents/` — each agent has its own file + optional `.test.ts`
- Skills are located in `src/skills/` (included in package publish)
- Multiplexer session management is in `src/multiplexer/`
- Council manager (multi-LLM orchestration) is in `src/council/`
- Tmux utilities are in `src/utils/tmux.ts`
- 468 tests across 35 files — run `bun test` to verify

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

- `.slim/clonedeps/repos/opencode-ai__opencode/` — `https://github.com/opencode-ai/opencode.git` at `main@73ee493265acf15fcd8caab2bc8cd3bd375b63cb`; inspect `packages/plugin` and `packages/sdk/js` for OpenCode plugin and SDK internals.
- `.slim/clonedeps/repos/opencode/` — `https://github.com/anomalyco/opencode.git` at `dev@356f6841865d68adf6d0123c37357ad50814497a`; inspect `packages/opencode` for latest TypeScript runtime internals and experimental background subagent support.
- `.slim/clonedeps/repos/modelcontextprotocol__typescript-sdk/` — `https://github.com/modelcontextprotocol/typescript-sdk.git` at `v1.29.0@e12cbd7078db388152f6e839abdbe09ba01f3f32`; inspect it for MCP protocol and server integration internals.
- `.slim/clonedeps/repos/agentclientprotocol__agent-client-protocol/` — `https://github.com/agentclientprotocol/agent-client-protocol.git` at `main@8110fde4e8283b4bef1329d1ef7b074fd14cee1e`; inspect it for ACP protocol specification and schema details.
