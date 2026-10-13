# src/agents/

## Responsibility

Defines agent personalities (Orchestrator, Explorer, Librarian, etc.) and manages their configuration lifecycle. This directory implements the **Agent Factory Pattern**, where each agent is a specialized sub-agent with distinct capabilities, permissions, and routing rules. The Orchestrator agent (src/agents/index.ts) coordinates task delegation to these specialists. Note: Council and Councillor agents are included for multi-model consensus, with Councillors created dynamically per preset.

## Design

### Agent Types and Factories

Each agent is a **prompt-driven specialist** with a factory function that creates an `AgentDefinition`:

| Agent | Factory | Role | Permissions | Model Default |
|-------|---------|------|-------------|---------------|
| **orchestrator** | `createOrchestratorAgent()` | Workflow manager that delegates tasks to specialists | Primary agent with full tool access | Resolved from config or runtime preset |
| **explorer** | `createExplorerAgent()` | Fast codebase search and pattern matching | Read-only by prompt (glob, grep, ast_grep_search) | DEFAULT_MODELS.explorer |
| **librarian** | `createLibrarianAgent()` | External documentation and library research | Read-only by prompt (context7, gh_grep) | DEFAULT_MODELS.librarian |
| **oracle** | `createOracleAgent()` | Strategic technical advisor and code reviewer | Read-only by prompt (read, glob, grep, ast_grep_search) | DEFAULT_MODELS.oracle |
| **designer** | `createDesignerAgent()` | UI/UX design, review, and implementation | Read/write (read, glob, grep, write, edit) | DEFAULT_MODELS.designer |
| **fixer** | `createFixerAgent()` | Fast implementation specialist for bounded tasks | Read/write (read, glob, grep, write, edit) | DEFAULT_MODELS.fixer |
| **observer** | `createObserverAgent()` | Visual analysis specialist (images, PDFs, diagrams) | Read-only by prompt (read, glob, grep, ast_grep_search) | DEFAULT_MODELS.observer |
| **council** | `createCouncilAgent()` | Multi-model consensus synthesis (read-only, no tools) | Read-only (council permission) | DEFAULT_MODELS.council |
| **councillor** | Created dynamically by `buildCouncillorAgents()` | Read-only council advisor; registered per preset seat as `councillor-<name>` | Read-only (read, glob, grep, ast_grep_search) | Inherited from council preset |

### Configuration System

- **Default prompts**: Each agent factory has a base prompt defined in its file (e.g., `explorer.ts`, `oracle.ts`)
- **User overrides**: From `~/.config/opencode/oh-my-opencode-slim.json` via `loadAgentPrompt()`
- **Agent colors**: Optional per-agent hex or theme-color overrides; no defaults (colorless agents get the host TUI's distinct palette colors)
- **Permission wildcards**: Applied via `applyDefaultPermissions()` in `index.ts`
- **Model resolution**: Supports string models, explicit `inheritModelFrom` policies, and priority-ordered arrays (`_modelArray`) for runtime fallback
- **Skill permissions**: Per-agent MCP and tool access controlled via `getSkillPermissionsForAgent()`
- **Council synthesis**: Uses `createSynthesisOnlyPermission()` to block tool calls while allowing synthesis from councillor responses

### Agent Lifecycle

1. **Agent creation**: `createAgents(config)` instantiates all agents with merged configuration
2. **Dynamic councillors**: `buildCouncillorAgents()` (`council-agents.ts`) creates one `councillor-<name>` subagent per council preset seat, attaching `_modelArray` fallback chains for multi-model councillors
3. **Permission application**: `applyDefaultPermissions()` sets `question` to allow (an explicit deny is kept), denies task control, `wait_for_user` and marketplace tools for every agent except the orchestrator, denies the file-mutation tools (`edit`, `write`, `apply_patch`, `ast_grep_replace`) for the orchestrator so implementation is delegated (#1012), and adds skill grants on top of each agent's map, preserving key order
4. **Task-rejection instruction**: `appendTaskRejectionInstruction()` appends the "outside your role" instruction to specialist prompts (`task-rejection.ts`)
5. **Display name injection**: Orchestrator prompt rewrites `@agent` mentions to user-configured display names
6. **Configuration export**: `getAgentConfigs()` converts `AgentDefinition` to OpenCode SDK format with classification metadata

## Flow

### Agent Instantiation Sequence (src/agents/index.ts)

```typescript
// 1. Gather sub-agent definitions with custom prompts
const protoSubAgents = Object.entries(SUBAGENT_FACTORIES)
  .filter(([name]) => !disabled.has(name))
  .map(([name, factory]) => {
    const customPrompts = loadAgentPrompt(name, config?.preset);
    return factory(getModelForAgent(name), customPrompts.prompt, customPrompts.appendPrompt);
  });

// 2. Apply overrides and default permissions
const builtInSubAgents = protoSubAgents.map((agent) => {
  const override = getAgentOverride(config, agent.name);
  if (override) applyOverrides(agent, override);
  applyDefaultPermissions(agent, override?.skills, config?.disabled_skills);
  return agent;
});

// 3. Create Orchestrator (with its own overrides and custom prompts)
const orchestrator = createOrchestratorAgent(
  orchestratorModel,
  orchestratorPrompts.prompt,
  orchestratorPrompts.appendPrompt,
  disabled,
);
applyDefaultPermissions(orchestrator, orchestratorOverride?.skills, config?.disabled_skills);

// 4. Collect display names and inject into orchestrator prompt
const displayNameMap = new Map<string, string>();
// ... populate from orchestrator and all subagents ...
injectDisplayNames(orchestrator, displayNameMap);

// 5. Append the static council seat pointer when dynamic councillors exist
//    (the full dispatch block is injected per-message by the council-inject
//    hook on keyword-triggered turns — see src/hooks/council-inject/)
// 6. Return agents array [orchestrator, ...allSubAgents]
return [orchestrator, ...allSubAgents];
```

### Council Synthesis Flow

The council agent is a synthesis-only specialist:
- Receives raw responses from multiple councillors (different models) via orchestrator dispatch
- Has NO tools - cannot read, glob, grep, or run shell commands
- Follows mandatory Synthesis Process steps before producing output
- Formats output with Council Response, Per-Councillor Details, and Council Summary sections
- `ensureCouncilSynthesisReinforcement()` re-applies the dual-track synthesis
  reinforcement (lean pointer when the base keeps the report format; compact
  fallback when a custom prompt override dropped it) to the final effective
  prompt; `ensureCouncilCompactionException()` keeps the host-template
  exception idempotently

### Model Resolution and Fallback

- **Priority arrays**: When `model` is configured as an array in user config, it's stored as `_modelArray`
- **Explicit inheritance**: `inheritModelFrom: "session"` and `"orchestrator"` leave the agent model unset so OpenCode follows the live parent/orchestrator model, including later runtime fallback switches
- **Runtime fallback**: ForegroundFallbackManager resolves models at runtime when API errors occur; independent specialist chains follow a real parent fallback through v2's per-call model/variant override or v1 prompt-claimed intentions: host state validates new children, while `task_id` and `task_revive` identify resumes; v1 `task_message` preserves transcript execution selection rather than stale session metadata
- **Preset overrides**: Runtime presets can override model/variant/temperature per agent

## Integration

### Consumed by src/index.ts

The main plugin entry point (`src/index.ts`) consumes the agent system:

```typescript
import { createAgents, getAgentConfigs } from './agents';

// During plugin initialization:
const agentDefs = createAgents(config);
const agents = getAgentConfigs(config);

// Register with OpenCode SDK
return {
  name: 'oh-my-opencode-slim',
  agent: agents, // SDK agent configs
  tool: tools,  // Tools including council tools
  mcp: mcps,    // MCP servers
  config: async (opencodeConfig) => { /* merge agent configs */ },
  event: async (input) => { /* session tracking, TUI state */ },
};
```

### Key Integration Points

1. **Agent selection**: OpenCode selects the orchestrator as the primary agent
2. **Task delegation**: Orchestrator delegates to specialists via the host delegation tool (`task`/`subagent_type` on v1; `subagent`/`agent` on v2)
3. **Session tracking**: `sessionAgentMap` tracks which agent owns each session for TUI prompts
4. **Model resolution**: ForegroundFallbackManager handles runtime model switching for rate limits
5. **Permission system**: MCP permissions are injected based on agent's `mcps` list

### Routing Rules (src/agents/orchestrator.ts)

The orchestrator's system prompt contains dynamic routing rules that reference agent capabilities:

- **@explorer**: Fast codebase recon, parallel searches
- **@librarian**: Library research, web search
- **@oracle**: Architecture decisions, code review
- **@designer**: UI/UX design and polish
- **@fixer**: Bounded implementation tasks
- **@observer**: Visual/media analysis
- **@council**: Multi-model consensus synthesis (orchestrator dispatches councillors directly in flatten mode)

These rules are filtered based on disabled agents and injected into the orchestrator's prompt at startup.

## File Structure

- `index.ts` - Main agent factory and configuration system
- `orchestrator.ts` - Orchestrator agent definition and prompt builder
- `explorer.ts` - Fast codebase search specialist
- `librarian.ts` - Documentation and library research specialist
- `oracle.ts` - Architecture and code review specialist
- `designer.ts` - UI/UX design specialist
- `fixer.ts` - Implementation execution specialist
- `observer.ts` - Visual analysis specialist
- `council.ts` - Multi-model consensus synthesis agent (synthesis only)
- `councillor.ts` - Read-only council advisor (internal)
- `council-agents.ts` - Dynamic `councillor-<name>` agent builders from council presets
- `task-rejection.ts` - Task-rejection instruction appended to specialist prompts
- `permissions.ts` - Permission factory for read-only agents

## Design Patterns

- **Factory Pattern**: Each agent has a factory function that creates its `AgentDefinition`
- **Strategy Pattern**: Different agents implement different strategies for different tasks
- **Decorator Pattern**: Configuration decorators (overrides, permissions, display names) wrap agent definitions
- **Observer Pattern**: Session tracking via `sessionAgentMap` and event handlers
- **Chain of Responsibility**: Task delegation flows from orchestrator to specialists
