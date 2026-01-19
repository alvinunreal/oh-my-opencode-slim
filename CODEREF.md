# Code Reference

Quick reference for understanding and extending oh-my-opencode-slim.

## Directory Structure

```
src/
├── agents/           # Agent definitions
├── cli/              # Installer CLI
├── config/           # Configuration loading & constants
├── features/         # Background task manager
├── mcp/              # MCP server configurations
├── tools/            # Tool definitions (background_task, etc.)
├── utils/            # Shared utilities
└── index.ts          # Plugin entry point
```

## Core Concepts

### 1. Plugin Entry Point

**File:** `src/index.ts`

```typescript
const OhMyOpenCodeLite: Plugin = async (ctx) => {
  return {
    name: "oh-my-opencode-slim",
    agent: agents,      // Agent configurations
    tool: tools,        // Custom tools
    mcp: mcps,          // MCP server configs
    config: (cfg) => {} // Modify OpenCode config
  };
};
```

### 2. Agents

**Location:** `src/agents/`

Each agent is a factory function that returns an `AgentDefinition`:

```typescript
// src/agents/example.ts
import type { AgentDefinition } from "./orchestrator";

export function createExampleAgent(model: string): AgentDefinition {
  return {
    name: "example",
    description: "What this agent does",
    config: {
      model,
      temperature: 0.1,
      system: PROMPT,
    },
  };
}
```

**To add a new agent:**

1. Create `src/agents/my-agent.ts`
2. Register in `src/agents/index.ts`:
   ```typescript
   import { createMyAgent } from "./my-agent";
   
   const SUBAGENT_FACTORIES = {
     // ...existing
     "my-agent": createMyAgent,
   };
   ```
3. Add to `AgentName` type in `src/config/schema.ts`
4. Add default model in `src/config/schema.ts` → `DEFAULT_MODELS`

### 3. MCP Servers

**Location:** `src/mcp/`

Built-in MCP servers enabled by default:

| MCP | Purpose | URL |
|-----|---------|-----|
| `websearch` | Real-time web search via Exa AI | `https://mcp.exa.ai/mcp` |
| `context7` | Official library documentation | `https://mcp.context7.com/mcp` |
| `grep_app` | GitHub code search via grep.app | `https://mcp.grep.app` |

**Files:**
- `src/mcp/types.ts` - MCP type definitions
- `src/mcp/websearch.ts` - Exa web search config
- `src/mcp/context7.ts` - Context7 docs config
- `src/mcp/grep-app.ts` - grep.app code search config
- `src/mcp/index.ts` - Factory function

**To add a new MCP:**

```typescript
// src/mcp/my-mcp.ts
import type { RemoteMcpConfig } from "./types";

export const my_mcp: RemoteMcpConfig = {
  type: "remote",
  url: "https://my-mcp-server.com/mcp",
  enabled: true,
  headers: process.env.MY_API_KEY
    ? { "x-api-key": process.env.MY_API_KEY }
    : undefined,
};
```

```typescript
// src/mcp/index.ts - add to allBuiltinMcps
import { my_mcp } from "./my-mcp";

const allBuiltinMcps: Record<McpName, RemoteMcpConfig> = {
  // ...existing
  my_mcp,
};

// src/mcp/types.ts - add to McpNameSchema
export const McpNameSchema = z.enum(["websearch", "context7", "grep_app", "my_mcp"]);
```

**Disabling MCPs:**

Users can disable MCPs in their config:
```json
{
  "disabled_mcps": ["websearch"]
}
```

### 4. Configuration

**Files:**
- `src/config/schema.ts` - Zod schemas & types
- `src/config/constants.ts` - Timeouts, intervals
- `src/config/loader.ts` - Config file loading

**Key Types:**

```typescript
// Agent override (user config)
type AgentOverrideConfig = {
  model?: string;
  temperature?: number;
  prompt?: string;
  prompt_append?: string;
  disable?: boolean;
};

// Plugin config structure
type PluginConfig = {
  agents?: Record<string, AgentOverrideConfig>;
  disabled_agents?: string[];
  disabled_mcps?: string[];
};
```

**Config file locations:**
- User: `~/.config/opencode/oh-my-opencode-slim.json`
- Project: `.opencode/oh-my-opencode-slim.json`

### 5. Tools

**Location:** `src/tools/`

Tools use the `@opencode-ai/plugin` SDK:

```typescript
import { tool } from "@opencode-ai/plugin";

const z = tool.schema;

const my_tool = tool({
  description: "What this tool does",
  args: {
    param1: z.string().describe("Description"),
    param2: z.boolean().optional(),
  },
  async execute(args, context) {
    // Implementation
    return "Result string";
  },
});
```

### 6. Background Tasks

**Files:**
- `src/features/background-manager.ts` - Task lifecycle management
- `src/tools/background.ts` - Tool definitions

**Flow:**
```
background_task (async)
    └── BackgroundTaskManager.launch()
           └── Creates session, sends prompt
           └── Polls for completion
           
background_task (sync)
    └── executeSync()
           └── Creates session
           └── Polls until stable
           └── Returns result directly
```

## Key Patterns

### Override Application

All agent overrides use the shared helper:

```typescript
// src/agents/index.ts
function applyOverrides(agent: AgentDefinition, override: AgentOverrideConfig): void {
  if (override.model) agent.config.model = override.model;
  if (override.temperature !== undefined) agent.config.temperature = override.temperature;
  if (override.prompt) agent.config.system = override.prompt;
  if (override.prompt_append) {
    agent.config.system = `${agent.config.system}\n\n${override.prompt_append}`;
  }
}
```

### Model Lookup Table

Provider-specific models defined in one place:

```typescript
// src/cli/config-manager.ts
const MODEL_MAPPINGS = {
  antigravity: {
    orchestrator: "google/claude-opus-4-5-thinking",
    // ...
  },
  openai: { /* ... */ },
  cerebras: { /* ... */ },
};
```

### Constants

All magic numbers centralized:

```typescript
// src/config/constants.ts
export const POLL_INTERVAL_MS = 500;
export const MAX_POLL_TIME_MS = 5 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const STABLE_POLLS_THRESHOLD = 3;
```

## Extending the Code

### Add a New Agent

```bash
# 1. Create agent file
touch src/agents/my-agent.ts
```

```typescript
// src/agents/my-agent.ts
import type { AgentDefinition } from "./orchestrator";

export function createMyAgent(model: string): AgentDefinition {
  return {
    name: "my-agent",
    description: "Short description for orchestrator",
    config: {
      model,
      temperature: 0.5,
      system: `Your prompt here...`,
    },
  };
}
```

```typescript
// src/agents/index.ts - add to SUBAGENT_FACTORIES
"my-agent": createMyAgent,

// src/config/schema.ts - add to AgentName
export type AgentName = "orchestrator" | ... | "my-agent";

// src/config/schema.ts - add to DEFAULT_MODELS
export const DEFAULT_MODELS: Record<AgentName, string> = {
  // ...
  "my-agent": "google/gemini-3-flash",
};
```

### Add a New Tool

```typescript
// src/tools/my-tool.ts
import { tool } from "@opencode-ai/plugin";

const z = tool.schema;

export const my_tool = tool({
  description: "What it does",
  args: {
    input: z.string(),
  },
  async execute(args) {
    return `Processed: ${args.input}`;
  },
});
```

```typescript
// src/tools/index.ts - export it
export { my_tool } from "./my-tool";

// src/index.ts - add to tool object
tool: {
  ...backgroundTools,
  my_tool,
},
```

### Add New Constants

```typescript
// src/config/constants.ts
export const MY_NEW_TIMEOUT_MS = 30_000;

// Use it
import { MY_NEW_TIMEOUT_MS } from "../config";
```

## File Quick Reference

| File | Purpose |
|------|---------|
| `src/index.ts` | Plugin entry, exports |
| `src/agents/index.ts` | Agent factory, override logic |
| `src/agents/orchestrator.ts` | Main orchestrator agent |
| `src/agents/fixer.ts` | Fast implementation specialist |
| `src/mcp/index.ts` | MCP factory, builtin MCPs |
| `src/mcp/websearch.ts` | Exa AI web search |
| `src/mcp/context7.ts` | Context7 docs lookup |
| `src/mcp/grep-app.ts` | GitHub code search |
| `src/config/schema.ts` | Types, Zod schemas, defaults |
| `src/config/constants.ts` | Timeouts, intervals |
| `src/config/loader.ts` | Config file loading |
| `src/tools/background.ts` | Background task tools |
| `src/features/background-manager.ts` | Task lifecycle |
| `src/utils/polling.ts` | Polling utilities |
| `src/cli/index.ts` | CLI entry point |
| `src/cli/install.ts` | Installation logic |
| `src/cli/config-manager.ts` | Config file management |

## Type Imports

```typescript
// SDK types
import type { Plugin, PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import type { AgentConfig as SDKAgentConfig } from "@opencode-ai/sdk";

// Local types
import type { AgentDefinition } from "./agents";
import type { PluginConfig, AgentOverrideConfig, AgentName, McpName } from "./config";
import type { RemoteMcpConfig } from "./mcp";
```

## Build & Test

```bash
# Build
bun run build

# Type check
bun run tsc --noEmit

# Run CLI
bun run src/cli/index.ts install
```
