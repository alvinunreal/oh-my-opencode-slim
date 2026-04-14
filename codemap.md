# Repository Atlas: oh-my-opencode-slim

## Project Responsibility

**oh-my-opencode-slim** is a lightweight agent orchestration plugin for OpenCode - a slimmed-down fork of oh-my-opencode. It provides a multi-agent system that enables specialized AI agents to work together under an orchestrator to optimize coding tasks for quality, speed, cost, and reliability.

The plugin integrates with OpenCode to provide:
- **Multi-agent orchestration** with specialized roles (Orchestrator, Explorer, Librarian, Oracle, Designer, Fixer)
- **Background task management** for long-running async operations
- **MCP (Model Context Protocol) integration** for external tools and services
- **LSP (Language Server Protocol) tools** for code intelligence
- **Code search capabilities** via grep and AST-grep
- **Tmux integration** for visual task tracking
- **Configuration system** with agent overrides and skill management
- **CLI installer** for interactive setup and configuration

## System Entry Points

| File | Purpose | Key Exports |
|------|---------|-------------|
| `package.json` | Project manifest, dependencies, and build scripts | `oh-my-opencode-slim` CLI, `dist/index.js` main entry |
| `src/index.ts` | Main plugin entry point | `OhMyOpenCodeLite` plugin, agent configs, tools, MCPs |
| `src/cli/index.ts` | CLI installer entry point | `install` command, configuration management |
| `tsconfig.json` | TypeScript compiler configuration | Build settings, type checking, declaration generation |

### Build Artifacts

- `dist/index.js` - Main plugin bundle (ESM)
- `dist/index.d.ts` - TypeScript declarations
- `dist/cli/index.js` - CLI bundle
- `dist/cli/index.d.ts` - CLI TypeScript declarations

### Published Files

- `dist/` - Built JavaScript and declarations
- `src/skills/` - Skill definitions (included in npm package)
- `README.md` - Documentation
- `LICENSE` - MIT license

## Repository Directory Map

| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `src/` | Main plugin entrypoint plus all feature modules that compose agents, tools, hooks, background managers, and utils. | [View Map](src/codemap.md) |
| `src/agents/` | Defines specialist agents and the orchestrator, with factories and override/permission helpers. | [View Map](src/agents/codemap.md) |
| `src/background/` | Background task/session managers and tmux pane orchestration for off-thread agent runs. | [View Map](src/background/codemap.md) |
| `src/cli/` | Installer CLI flow, config edits, provider setup, and skill installation helpers. | [View Map](src/cli/codemap.md) |
| `src/config/` | Plugin configuration schemas, defaults, loaders, and MCP/agent override helpers. | [View Map](src/config/codemap.md) |
| `src/hooks/` | Lifecycle hooks for message transforms, error recovery, and rate-limit fallbacks. | [View Map](src/hooks/codemap.md) |
| `src/hooks/auto-update-checker/` | Startup update check hook with cache invalidation and optional auto-install. | [View Map](src/hooks/auto-update-checker/codemap.md) |
| `src/hooks/phase-reminder/` | Orchestrator message transform hook that injects phase reminders. | [View Map](src/hooks/phase-reminder/codemap.md) |
| `src/hooks/post-file-tool-nudge/` | Read/Write tool after-hook that queues ephemeral delegation nudges. | [View Map](src/hooks/post-file-tool-nudge/codemap.md) |
| `src/hooks/delegate-task-retry/` | Error detection and retry guidance with pattern matching and assistance. | [View Map](src/hooks/delegate-task-retry/codemap.md) |
| `src/hooks/foreground-fallback/` | Rate-limit fallback manager for interactive sessions. | [View Map](src/hooks/foreground-fallback/codemap.md) |
| `src/hooks/json-error-recovery/` | JSON parse error detection and recovery helpers. | [View Map](src/hooks/json-error-recovery/codemap.md) |
| `src/mcp/` | Built-in MCP registry and config types for remote connectors. | [View Map](src/mcp/codemap.md) |
| `src/tools/` | Tool registry plus LSP, AST-grep, and background task implementations. | [View Map](src/tools/codemap.md) |
| `src/tools/ast-grep/` | AST-grep CLI discovery, execution, and tool definitions. | [View Map](src/tools/ast-grep/codemap.md) |
| `src/tools/lsp/` | LSP client stack and tool surface for definitions, diagnostics, and rename. | [View Map](src/tools/lsp/codemap.md) |
| `src/utils/` | Shared helpers for tmux, environment variables, internal initiation, and config. | [View Map](src/utils/codemap.md) |

## Architecture Overview

### Plugin Initialization Flow

```
OpenCode loads plugin
    ↓
src/index.ts: OhMyOpenCodeLite(ctx)
    ↓
Load plugin config (src/config)
    ↓
Initialize agent configs (src/agents)
    ↓
Initialize background manager (src/background)
    ↓
Initialize MCPs (src/mcp)
    ↓
Initialize hooks (src/hooks)
    ↓
Register tools (src/tools)
    ↓
Return plugin object with:
    - agent: Agent configurations
    - tool: Tool implementations
    - mcp: MCP configurations
    - config: Config merger
    - event: Event handlers
    - hooks: Message transforms
```

### Key Integrations

1. **Agent System** (`src/agents/`)
   - Orchestrator delegates to specialized subagents
   - Each agent has specific tools, permissions, and temperature settings
   - MCP tools configured per agent based on role

2. **Background Tasks** (`src/background/`)
   - Fire-and-forget task execution
   - Session lifecycle management
   - Optional tmux pane integration for visual tracking

3. **Configuration** (`src/config/`)
   - User, project, and preset config layers
   - Agent overrides and custom prompts
   - MCP availability and permissions

4. **Tools** (`src/tools/`)
   - Code search (grep, AST-grep)
   - LSP integration (diagnostics, references, rename)
   - Background task orchestration

5. **MCP Integration** (`src/mcp/`)
   - Built-in remote MCPs (websearch, context7, grep.app)
   - Type-safe configuration
   - Disabled MCP filtering

6. **Hooks** (`src/hooks/`)
   - Auto-update checking
   - `apply_patch` stale-patch rescue with strict parsing, bounded LCS fallback, stateful same-path helper updates, and safe canonical rewrites only inside root/worktree
   - Phase reminders for workflow compliance
   - Post-read nudges for delegation

## Development Workflow

```bash
# Build the project
bun run build

# Type checking
bun run typecheck

# Run tests
bun test

# Linting
bun run lint

# Format code
bun run format

# Run all checks (lint + format + organize imports)
bun run check

# CI mode checks (no auto-fix)
bun run check:ci

# Build and run with OpenCode
bun run dev
```

## Key Dependencies

| Dependency | Purpose |
|------------|---------|
| `@opencode-ai/plugin` | OpenCode plugin SDK |
| `@opencode-ai/sdk` | OpenCode AI SDK |
| `@modelcontextprotocol/sdk` | MCP protocol implementation |
| `@ast-grep/cli` | AST-aware code search |
| `vscode-jsonrpc` | JSON-RPC protocol |
| `vscode-languageserver-protocol` | LSP protocol |
| `zod` | Runtime validation |

## Extension Points

### Adding New Agents

1. Create agent definition in `src/agents/`
2. Add to agent factory registry
3. Configure default model in `src/config/constants.ts`
4. Add MCP configuration in `src/config/agent-mcps.ts`
5. Add skill permissions in `src/cli/skills/`

### Adding New Tools

1. Implement tool in `src/tools/`
2. Export from `src/tools/index.ts`
3. Register in main plugin (`src/index.ts`)
4. Configure agent permissions

### Adding New MCPs

1. Define MCP config in `src/mcp/`
2. Add to `createBuiltinMcps` registry
3. Configure agent access in `src/config/agent-mcps.ts`

### Adding New Hooks

1. Implement hook in `src/hooks/`
2. Export factory function from `src/hooks/index.ts`
3. Register in main plugin (`src/index.ts`)

## Configuration Structure

```typescript
interface PluginConfig {
  agents?: {
    [agentName: string]: AgentOverrideConfig;
  };
  tmux?: TmuxConfig;
  disabled_mcps?: McpName[];
  background?: BackgroundTaskConfig;
  presets?: Record<string, Partial<PluginConfig>>;
}
```

## License

MIT License - See [LICENSE](LICENSE) for details.
