# Agent Coding Guidelines

This document provides guidelines for AI agents operating in this repository.

## Project Overview

**omoslim** - A packet-based agent orchestration plugin for Claude Code, a slimmed-down
fork of oh-my-opencode. Built with TypeScript, Bun, and Biome.

Agents communicate via **PacketV1** YAML packets (≤2,500 chars). Tool outputs are
capped by the **airlock hook** before entering agent context. Delegates return
structured packets, not raw text.

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
| `bun run dev` | Build and run with Claude Code |

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
omoslim/
├── src/
│   ├── index.ts              # Plugin entry point — wires agents, tools, hooks, events
│   ├── agents/               # Agent definitions (orchestrator, explorer, librarian,
│   │                         #   oracle, designer, fixer, summarizer)
│   ├── background/           # TmuxSessionManager — pane lifecycle only
│   ├── cli/                  # CLI entry point (install, models commands)
│   ├── config/               # Config loading, schema, agent-MCP permission rules
│   ├── delegates/            # PacketTaskManager — delegate_task / packet_context /
│   │                         #   resolve_pointer tools; packet extraction pipeline
│   ├── hooks/
│   │   ├── airlock/          # tool.execute.after hook — caps all tool outputs
│   │   └── auto-update-checker/  # Startup toast for new npm versions
│   ├── mcp/                  # Built-in MCP server definitions (websearch, context7,
│   │                         #   grep_app)
│   ├── skills/               # Custom bundled skills (cartography)
│   ├── token-discipline/     # Packet schema, airlock caps, thread archiving,
│   │                         #   pointer resolver, metrics, task router, validator
│   ├── tools/                # lsp_*, grep, ast_grep_search, ast_grep_replace
│   └── utils/                # logger, session helpers, tmux utils
├── dist/                     # Built JavaScript and declarations
├── biome.json                # Biome configuration
├── tsconfig.json             # TypeScript configuration
└── package.json              # Project manifest and scripts
```

## Key Dependencies

- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `@opencode-ai/sdk` - Claude Code AI SDK
- `zod` - Runtime validation
- `vscode-jsonrpc` / `vscode-languageserver-protocol` - LSP support

## Development Workflow

1. Make code changes
2. Run `bun run check:ci` to verify linting and formatting
3. Run `bun run typecheck` to verify types
4. Run `bun test` to verify tests pass
5. Commit changes

## Token Discipline / Packet System

The core design principle: **delegates return packets, not raw text.**

### Packet Format (PacketV1)

Subagent responses must include a YAML block:

```yaml
tldr:
  - Key insight 1
  - Key insight 2
evidence:
  - file:src/main.ts:42-80
  - thread:abc123#context
  - https://docs.example.com/api
recommendation: Single clear recommendation
next_actions:
  - Actionable step 1
  - Actionable step 2
```

Constraints: total ≤2,500 chars, tldr 1–3 bullets, evidence 1–5 bullets,
next_actions 1–5 bullets. Content fields must use the agent's own words — no
raw URLs or tool output dumps.

### Airlock (Tool Output Capping)

The `tool.execute.after` hook in `src/hooks/airlock/` caps every tool output
before it enters agent context:

| Tool | Cap |
|------|-----|
| `bash` | 250 lines |
| `git_diff` | 400 lines |
| `git_log` | 100 lines |
| `file_read` | 12 KB |
| `web_fetch` | 8 KB |
| `context7` | 16 KB |
| `grep_app` | 200 results |

Package-manager noise (npm WARN, yarn warning, progress bars) is stripped first.

### Delegation Tools

| Tool | Description |
|------|-------------|
| `delegate_task` | Launch a subagent; `wait=true` (default) blocks and returns packet inline; `wait=false` fires async |
| `packet_context` | Retrieve and merge packets from one or more async delegates by task ID |
| `resolve_pointer` | Dereference `thread:`, `file:`, or `cmd:` evidence pointers from packets |

**Single delegate (blocking):**
```
delegate_task(description="...", prompt="...", agent="librarian")
# packet returned inline — no separate packet_context call needed
```

**Parallel delegates:**
```
delegate_task(..., agent="explorer", wait=false)   # returns task ID immediately
delegate_task(..., agent="librarian", wait=false)  # returns task ID immediately
packet_context(task_id="pkt_abc,pkt_def", timeout=120000)
# returns merged packet
```

### Fallback Packets

When a delegate can't produce a valid packet (output too large, parse failure,
validation error), a fallback packet is emitted with `[fallback: reason]` in
the `options` field and a `thread:id` pointer in `evidence`.

Handle fallbacks — never treat them as authoritative:

```
# Quick peek (500 chars):
resolve_pointer(pointer="thread:abc123#context")

# Full compression:
delegate_task(description="compress fallback", prompt="Summarize thread:abc123", agent="summarizer")
```

### resolve_pointer Quota

3 resolutions per user request. Reset automatically at the start of each new
request. Use surgically — only when a fallback packet or a specific file range
is essential to the next decision.

### Configuration (`omoslim.json`)

The `omoslim.json` file (located at `~/.config/opencode/omoslim.json`) uses **role-based keys**, not agent names:

| Role Key | Agent | Description |
|----------|-------|-------------|
| `orchestrator` | orchestrator | Primary decision-maker |
| `researcher` | librarian | External docs and library research |
| `repo_scout` | explorer | Codebase analysis and file finding |
| `implementer` | fixer | Code generation and changes |
| `validator` | oracle | Testing and code review |
| `designer` | designer | UI/UX and styling work |
| `summarizer` | summarizer | Emergency packet compression |

**Example `omoslim.json`:**

```json
{
  "model_assignments": {
    "orchestrator": {
      "model": "anthropic/claude-opus-4",
      "tier": "premium"
    },
    "researcher": {
      "model": "anthropic/claude-haiku-3.5",
      "tier": "cheap"
    },
    "repo_scout": {
      "model": "anthropic/claude-haiku-3.5",
      "tier": "cheap"
    },
    "implementer": {
      "model": "anthropic/claude-sonnet-4",
      "tier": "mid"
    },
    "validator": {
      "model": "anthropic/claude-sonnet-4",
      "tier": "mid"
    },
    "designer": {
      "model": "anthropic/claude-sonnet-4",
      "tier": "mid"
    },
    "summarizer": {
      "model": "anthropic/claude-haiku-3.5",
      "tier": "cheap"
    }
  },
  "model_fallbacks": {
    "premium": ["anthropic/claude-opus-4", "openai/gpt-4o"],
    "mid": ["anthropic/claude-sonnet-4", "openai/gpt-4o"],
    "cheap": ["anthropic/claude-haiku-3.5", "openai/gpt-4o-mini"]
  }
}
```

See `omoslim.example.json` in the repository root for a complete example.

### OMOSLIM_PRESET Environment Variable

Override the active config preset without editing the config file:

```bash
export OMOSLIM_PRESET=openai
opencode
```

Takes precedence over the `preset` field in the config file.

## Tmux Session Lifecycle

Understanding the session lifecycle is crucial for preventing orphaned processes
and ghost panes.

### Session Lifecycle Flow

```
Task Launch:
  delegate_task() → session.create() → tmux pane spawned → task runs
                                      → airlock caps tool outputs

Task Completes Normally:
  session.status (idle) → extract packet → processDelegateOutput()
  → session.abort() → session.deleted event → tmux pane closed

Task Cancelled:
  cancel() → session.abort() → session.deleted event → tmux pane closed

Session Deleted Externally:
  session.deleted event → task cleanup → tmux pane closed
```

### Key Implementation Details

**1. Graceful Shutdown (`src/background/tmux-session-manager.ts`)**
```typescript
// Always send Ctrl+C before killing pane
spawn([tmux, 'send-keys', '-t', paneId, 'C-c'])
await delay(250)
spawn([tmux, 'kill-pane', '-t', paneId])
```

**2. Session Abort Timing (`src/delegates/index.ts`)**
- Call `session.abort()` AFTER extracting the packet
- This ensures content is preserved before session termination
- Triggers `session.deleted` event for cleanup

**3. Event Handlers (`src/index.ts`)**
All four handlers must be wired up:
- `packetManager.handleSessionStatus()` — detects idle → extracts packet
- `packetManager.handleSessionDeleted()` — cleans up task state
- `tmuxSessionManager.onSessionStatus()` — triggers pane close on idle
- `tmuxSessionManager.onSessionDeleted()` — closes tmux pane

### Testing Tmux Integration

After making changes to session management:

```bash
# 1. Build the plugin
bun run build

# 2. Run from local fork (in ~/.config/opencode/opencode.jsonc):
# "plugin": ["file:///path/to/omoslim"]

# 3. Launch test tasks
@explorer count files in src/
@librarian search for Bun documentation

# 4. Verify no orphans
ps aux | grep "opencode attach" | grep -v grep
# Should return 0 processes after tasks complete
```

### Common Issues

**Ghost panes remaining open:**
- Check that `session.abort()` is called after packet extraction
- Verify `session.deleted` handler is wired in `src/index.ts`

**Orphaned opencode attach processes:**
- Ensure graceful shutdown sends Ctrl+C before kill-pane
- Check that tmux pane closes before process termination

## Pre-Push Code Review

Before pushing changes to the repository, always run a code review to catch
issues like duplicate code, redundant function calls, race conditions, and logic
errors.

### Using `/review` Command (Recommended)

Claude Code has a built-in `/review` command that automatically performs
comprehensive code reviews:

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
- Standardized review process with consistent focus areas (bugs, structure,
  performance)
- Automatically handles git operations (diff, status, etc.)
- Context-aware: reads full files and convention files (AGENTS.md, etc.)
- Delegates to specialized @build subagent with proper permissions
- Provides actionable, matter-of-fact feedback

### Workflow Before Pushing

1. **Make your changes**
2. **Stage changes:** `git add .`
3. **Run code review:** `/review`
4. **Address any issues found**
5. **Run checks:** `bun run check:ci && bun test`
6. **Commit and push**

**Note:** The `/review` command found issues in our PR #127 (duplicate code,
redundant abort calls) that neither linter nor tests caught. Always use it
before pushing!

## Common Patterns

- This is a Claude Code plugin — most functionality lives in `src/`
- The CLI entry point is `src/cli/index.ts`
- The main plugin export is `src/index.ts`
- Delegation logic (tools + packet pipeline) is in `src/delegates/index.ts`
- Packet schema, airlock, thread archiving, pointer resolver are in
  `src/token-discipline/`
- Skills are located in `src/skills/` (included in package publish)
- Tmux pane management is in `src/background/tmux-session-manager.ts`
