# src/tools/

## Responsibility

Centralized tool factory and registry for the OpenCode plugin system. This directory defines all executable tools exposed to OpenCode agents, including:

- **Agent orchestration tools**: Multi-LLM council sessions, task cancellation, and ACP agent execution
- **Code intelligence tools**: AST-grep pattern matching and transformation across languages
- **Web capabilities**: Smart web fetching with caching and secondary model processing
- **Runtime configuration**: Preset management for dynamic agent configuration switching

These tools enable agents to perform file operations, orchestrate multi-model consensus, manage background tasks, and interact with external systems while maintaining security boundaries through the OpenCode tool schema.

## Design

### Architecture Pattern: **Tool Factory Pattern**

Each tool is implemented as a factory function that returns a `ToolDefinition` record compatible with the `@opencode-ai/plugin` SDK. The pattern provides:

- **Encapsulation**: Tool creation logic and dependencies are isolated per tool
- **Composition**: Tools can be selectively exported and composed in `src/tools/index.ts`
- **Testability**: Factories accept dependencies as parameters, enabling mock injection
- **Type Safety**: Zod schemas validate tool arguments at runtime

### Core Tool Families

| Tool Family | Purpose | Key Components |
|------------|---------|----------------|
| **Council** | Multi-LLM consensus orchestration | `council.ts`, `council-manager.ts` |
| **Task Management** | Background task lifecycle control | `cancel-task.ts`, `background-job-board.ts` |
| **ACP Integration** | External agent protocol execution | `acp-run.ts`, ACP client implementation |
| **Code Intelligence** | AST-based code manipulation | `ast-grep/` directory, `tools.ts` |
| **Web Fetching** | Intelligent web content retrieval | `smartfetch/` directory, `tool.ts` |
| **Preset Management** | Runtime agent configuration | `preset-manager.ts`, TUI state integration |

### Security & Validation

- **Agent Restrictions**: Tools validate calling agent identity (e.g., `council_session` only callable by `council` agent)
- **Permission Prompts**: Web fetching and ACP tools require explicit user permission via `ctx.ask()`
- **Timeout Controls**: Configurable timeouts prevent unbounded execution
- **Input Sanitization**: Zod schemas validate all tool arguments

### State Management

- **Runtime Presets**: Preset state persists across plugin reloads via `runtime-preset.ts`
- **TUI Integration**: Preset changes update the terminal UI snapshot for immediate feedback
- **Background Jobs**: Task cancellation uses a centralized job board for tracking and cleanup

## Flow

### Tool Creation Lifecycle

```
1. Plugin Initialization (src/index.ts)
   └─> registerTools() calls each tool factory with dependencies
      
2. Tool Factory Execution
   ├─> Accepts PluginInput context and domain-specific dependencies
   ├─> Validates configuration and environment
   ├─> Returns ToolDefinition record with execute() handler
   └─> Registers tool with OpenCode via plugin API

3. Tool Invocation
   ├─> Agent calls tool with validated arguments
   ├─> Tool executes business logic
   ├─> May call ctx.ask() for user permission
   ├─> Returns structured result or error
   └─> OpenCode presents result to agent
```

### Council Session Flow (Multi-LLM Orchestration)

```
1. Agent invokes council_session tool
   ├─> Validates calling agent is 'council'
   ├─> Receives prompt and optional preset
   ├─> Delegates to CouncilManager.runCouncil()
   │   ├─> Spawns parallel councillor sessions
   │   ├─> Collects formatted responses
   │   └─> Synthesizes final output with model composition footer
   └─> Returns consensus result to agent
```

### Task Cancellation Flow

```
1. Orchestrator invokes cancel_task tool
   ├─> Validates calling agent is 'orchestrator'
   ├─> Resolves task_id to BackgroundJobBoard entry
   ├─> Calls abortSessionWithTimeout() to signal cancellation
   ├─> Verifies session stopped via status polling
   ├─> Marks job as cancelled in BackgroundJobBoard
   └─> Returns cancellation confirmation
```

### ACP Agent Execution Flow

```
1. Agent invokes acp_run tool
   ├─> Validates calling agent matches configured agent name
   ├─> Spawns ACP client process with config
   ├─> Sends prompt via JSON-RPC over stdin/stdout
   ├─> Handles permission requests via ctx.ask()
   ├─> Collects streaming output chunks
   ├─> Enforces timeout if configured
   └─> Returns concatenated output or error
```

### AST-grep Pattern Matching Flow

```
1. Agent invokes ast_grep_search or ast_grep_replace
   ├─> Validates language support and pattern syntax
   ├─> Ensures CLI binary available (downloads if needed)
   ├─> Executes sg (AST-grep CLI) process
   ├─> Parses JSON output into structured matches/edits
   └─> Returns typed results to agent
```

### Web Fetching Flow

```
1. Agent invokes webfetch tool
   ├─> Validates URL and configuration
   ├─> Checks cache for fresh content
   ├─> If cache miss, fetches via network with timeout
   ├─> Optionally processes with secondary model
   ├─> Caches result for future requests
   └─> Returns extracted content to agent
```

## Integration


### Consumers

- **Main Plugin** (`src/index.ts`):
  - `registerTools()` - Registers all exported tools with OpenCode
  - `getToolDefinitions()` - Composes tool set for plugin initialization
  
- **Agents** (`src/agents/`):
  - Council agent uses `council_session` tool
  - Individual agents use `acp_run` tool for specialized tasks
  - All agents use `ast_grep_search`/`ast_grep_replace` for code manipulation

- **CLI** (`src/cli/`):
  - Preset manager integrates with `/preset` command
  - Tool factories receive CLI configuration for ACP agents

### Dependencies

| Dependency | Purpose |
|------------|---------|
| `@opencode-ai/plugin` | Tool schema and execution framework |
| `CouncilManager` (`src/council/`) | Multi-LLM orchestration engine |
| `BackgroundJobBoard` (`src/utils/`) | Background task tracking and cleanup |
| `Config System` (`src/config/`) | ACP agent configurations and presets |
| `TUI State` (`src/tui-state.ts`) | Preset visualization in terminal UI |
| `AST-grep CLI` | Pattern matching and transformation engine |
| `Network Utilities` | Web fetching and caching |

### Cross-Module Data Flow

```
Tools Layer → Council Layer
├─ council_session tool → CouncilManager.runCouncil()
└─> Returns consensus result with model composition footer

Tools Layer → Background Layer
├─ cancel_task tool → BackgroundJobBoard.resolve() → abortSessionWithTimeout()
└─> Returns cancellation status

Tools Layer → Config Layer
├─ acp_run tool → AcpAgentsConfig from config system
├─ preset-manager → Preset configurations from plugin config
└─> Validates and applies runtime configuration

Tools Layer → AST-grep Layer
├─ ast_grep_search/ast_grep_replace → CLI binary execution
└─> Returns typed AST matches and edit results

Tools Layer → Web Layer
└─ webfetch tool → Network utilities with caching and model processing
```

### Configuration Integration

- **ACP Agents**: Defined in `src/config/agents.ts`, consumed by `acp_run.ts`
- **Presets**: Defined in plugin config (`oh-my-opencode-slim.jsonc`), managed by `preset-manager.ts`
- **Council**: Configured via council presets, validated by `council.ts`


### Error Handling & Recovery

- **Session Aborts**: `cancel-task.ts` implements robust abort verification with polling and cleanup
- **Timeouts**: All network and process operations enforce configurable timeouts
- **Permission Denials**: Tools gracefully handle user rejection via `ctx.ask()`
- **Binary Availability**: `ast-grep/` tools auto-download CLI on first use


## Tool Reference

### Exported Tools (src/tools/index.ts)

```typescript
// AST-grep tools
export { createAcpRunTool } from './acp-run';
export { ast_grep_replace, ast_grep_search } from './ast-grep';

// Task management
export { createCancelTaskTool } from './cancel-task';

// Council orchestration
export { createCouncilTool } from './council';

// Preset management
export type { PresetManager } from './preset-manager';
export { createPresetManager } from './preset-manager';

// Web fetching
export { createWebfetchTool } from './smartfetch';
```

### Tool-Specific Configuration


#### ACP Agents (acp-run.ts)
- Configured in `src/config/agents.ts` as `AcpAgentsConfig`
- Each agent requires: `command`, `args`, `cwd`, `permissionMode`
- Supports: `ask` (prompt user), `reject` (auto-deny), `allow` (auto-approve)

#### Council Sessions (council.ts)
- Configured via council presets in plugin config
- Requires council agent to be registered in OpenCode
- Supports preset-specific councillor configurations

#### Presets (preset-manager.ts)
- Defined in plugin config under `presets` field
- Each preset maps agent names to `AgentOverrideConfig`
- Changes persist across plugin reloads via user config file

#### AST-grep (ast-grep/)
- Auto-downloads CLI binary on first use
- Supports 25+ languages via CLI_LANGUAGES constant
- Provides search (pattern matching) and replace (transformation) tools

#### Webfetch (smartfetch/)
- Implements caching with configurable TTL
- Supports secondary model processing for content extraction
- Handles redirects, timeouts, and error recovery

## Testing Strategy

- **Unit Tests**: Individual tool factories tested in `*.test.ts` files
- **Integration Tests**: Tools tested with mock dependencies and OpenCode context
- **E2E Tests**: Council and ACP tools tested with real external services
- **Binary Tests**: AST-grep CLI availability and functionality verified

## Performance Considerations

- **Binary Downloads**: AST-grep CLI downloaded once and cached
- **Network Caching**: Webfetch results cached to avoid redundant requests
- **Timeout Enforcement**: Prevents unbounded execution of external tools
- **Parallel Execution**: Council sessions run councillors in parallel

## Security Considerations

- **Agent Restrictions**: Tools validate calling agent identity
- **Permission Prompts**: User approval required for web and ACP operations
- **Input Validation**: Zod schemas validate all tool arguments
- **Process Isolation**: ACP agents run in separate processes
- **Timeout Controls**: Prevents denial-of-service via hanging operations
