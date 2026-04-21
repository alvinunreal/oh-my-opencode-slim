# Agents Directory Codemap

## Responsibility

`src/agents/` defines all built-in and user-defined AI agents and the registry that converts configuration into OpenCode SDK agent definitions.

Responsibilities:

- Construct orchestrator + specialist agents with prompt customization and runtime overrides.
- Apply model/temperature/variant/options override behavior, including fallback arrays.
- Resolve permissions and tool access (skills + MCPs + council tool gate).
- Expose internal-only and user-facing agent visibility/state to OpenCode.

## Core architecture

### Construction flow

`createAgents(config?)`

1. Read disabled set:
   - from `config.disabled_agents`
   - applies protected-agent guard (`orchestrator`, `councillor` cannot be disabled).
2. Create built-in subagents from `SUBAGENT_FACTORIES`.
3. Discover custom agents from config keys in `config.agents` that are not built-in/aliases.
4. Load prompt overrides for each agent:
   - `<agent>.md` replacement prompt
   - `<agent>_append.md` appended prompt
   - preset-scoped prompt lookup path if `preset` exists.
5. Apply overrides (`model`, `temperature`, `variant`, `options`, `displayName`) and default permissions.
6. Build orchestrator last using its own prompt and disabled-agent filtered orchestration prompt.
7. Validate and apply custom display-name map to orchestrator and custom prompts.

Custom agents:

- Require a safe name not colliding with built-ins.
- Require explicit model (string or non-empty array).
- Skip if model is missing.
- Built with `buildCustomAgentDefinition(...)` and allow `prompt`/`orchestratorPrompt`/`model`-chain overrides.

### Runtime model behavior

- `AgentDefinition.config.model` can be set directly, or set `_modelArray` for ordered fallback models and clear direct model so resolution occurs later.
- `orchestrator` default model is left open for runtime resolution when unset.
- `fixer` temporary fallback: if no override, it inherits `librarian` model.

### Delegation and visibility

- Modes set in `getAgentConfigs()`:
  - `orchestrator` → `primary`
  - built-in subagents → `subagent`
  - `council` → `all` (callable directly and via delegation)
  - `councillor` → `subagent`, `hidden: true` (internal)
- Permission defaults:
  - `question` defaults to `allow` unless already denied.
  - `skill` comes from configured/default skill presets.
  - `council_session` is `allow` only for `council`.

## Capability and policy inputs

- MCP list selection: `getAgentMcpList(name, config)` from `config/agent-mcps.ts`.
- Agent metadata overrides and aliases: `config/` exports (`getAgentOverride`, `getCustomAgentNames`, `AGENT_ALIASES`).
- Skill permissions: `cli/skills.ts`.

## Flow and integration

```text
src/index.ts
  └─> createAgents(config)
      └─> [orchestrator, explorer, librarian, oracle, designer, fixer, observer, council, councillor(custom)]
          └─> getAgentConfigs(config)
              └─> OpenCode register
```

```text
loadPluginConfig()
  └─> prompt files + overrides
      └─> createAgents()/getAgentConfigs()
```

## Key control points

- `src/agents/index.ts` now includes extended agent surface and custom-agent extension.
- `orchestrator.ts` owns prompt composition and dynamic disabled-agent filtering.
- `council.ts` + `councillor.ts` provide council-agent prompts and result formatter helpers.

## File structure

- `index.ts` (registry, overrides, visibility, disabled/visible behavior)
- `orchestrator.ts` (base orchestrator prompt + prompt resolution)
- `council.ts`, `councillor.ts` (council-specific definitions + formatting helpers)
- `observer.ts`, `explorer.ts`, `librarian.ts`, `oracle.ts`, `designer.ts`, `fixer.ts`
