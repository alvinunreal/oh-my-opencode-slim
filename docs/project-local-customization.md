# Project-local Customization

This document describes how to configure and customize oh-my-opencode-slim on a per-project (repository-specific) basis. Project-local customization allows teams and repositories to define custom agents, override systemic prompts, restrict skills, and orchestrate MCP configurations without polluting global user configurations.

## Security & Trust Boundary Warning

> ⚠️ **IMPORTANT SECURITY NOTICE**
> Because project-local configuration files (`.opencode/oh-my-opencode-slim.jsonc`) and prompt templates (`.opencode/oh-my-opencode-slim/`) are loaded automatically when you open and work in a project directory, they can modify agent behaviors, enable/disable tools, and grant extra model access permissions.
> **Only work in and run OpenCode within repositories you explicitly trust.**

---

## Feature Comparison

| Feature | Scope / Location | Description |
|---|---|---|
| **Configuration file** | `.opencode/oh-my-opencode-slim.json[c]` | Project-level configuration file that overrides global user settings, merging presets, agent profiles, and multiplexer integration. |
| **Custom agents** | `agents` configuration block | Define new specialized agents by keying them under `agents.<custom-name>` with required `model`, custom system `prompt`, and optional routing guidance. |
| **Built-in prompt overrides** | `.opencode/oh-my-opencode-slim/<agent>.md` | Completely override the built-in system prompt for any agent (e.g. `oracle.md`, `explorer.md`, `orchestrator.md`, or custom agents). |
| **Append prompts** | `.opencode/oh-my-opencode-slim/<agent>_append.md` | Append additional rules or guidelines to the existing base (inline or default built-in) prompt without overriding it completely. |
| **Per-agent skills** | `agents.<agent>.skills` | Explicitly restrict or authorize specific local codebase skills/scripts that this agent is allowed to execute. |
| **Per-agent MCPs** | `agents.<agent>.mcps` | Assign, restrict, or authorize specific Model Context Protocol (MCP) servers (like `websearch` or `context7`) to specific agents. |
| **Presets** | `presets` configuration block | Bundle named agent environments. User and project preset definitions deep-merge; the active preset then merges into `agents`. |
| **Precedence** | User config, project config, presets, prompt files | Project-local settings take precedence over user-global settings, while root `agents.*` entries beat active preset entries. |

---

## Configuration Precedence

When oh-my-opencode-slim loads, it resolves configuration properties and prompt templates across multiple layers. The inheritance precedence operates strictly as follows:

```
[Built-in Defaults]
       ↓ (overridden by)
[User Config] (global)
       ↓ (overridden by)
[Project Config] (local repository)
       ↓ (overridden by)
[Environment Preset Override] (via OH_MY_OPENCODE_SLIM_PRESET env var)
       ↓ (merged into agents)
[Active Preset] (merges preset-specific agent options)
       ↓ (overridden by)
[Root Config agents.*] (individual agent configs beat preset configurations)
```

### Note on Root Overrides vs Presets
The root `agents.*` configuration (defined at the top level of user or project config) always takes precedence over the active preset configurations. To override a root agent choice globally, you must specify the override in the project-level root `agents.*` rather than inside a local preset configuration alone.

---

## Prompt Lookup Precedence

When looking up markdown prompt template files (such as `<agent>.md` or `<agent>_append.md`), oh-my-opencode-slim searches directories in a strict hierarchical order. Precedence is evaluated for the replacement prompt file and the append prompt file **independently** in the following sequence:

1. **Project Preset Directory**
   `<project>/.opencode/oh-my-opencode-slim/<preset>/<agent>.md` (if preset is active and safe)
2. **Project Root Directory**
   `<project>/.opencode/oh-my-opencode-slim/<agent>.md`
3. **User Preset Directory (Global)**
   `<user-config-dir>/oh-my-opencode-slim/<preset>/<agent>.md`
4. **User Root Directory (Global)**
   `<user-config-dir>/oh-my-opencode-slim/<agent>.md`

---

## Prompt Composition Rules

For any agent, the final system prompt is computed dynamically using the following formula:

1. **Calculate Base Prompt:**
   ```
   base = inlinePrompt ?? defaultBuiltInPrompt
   ```
   - For built-in agents, `defaultBuiltInPrompt` is their factory template.
   - For custom agents, `defaultBuiltInPrompt` defaults to `"You are the <name> specialist."`.
   - `inlinePrompt` is the inline `prompt` string configured directly inside the `agents.<agent>.prompt` object.

2. **Calculate Effective Base:**
   ```
   effectiveBase = filePrompt ?? base
   ```
   - `filePrompt` is the content of the resolved `<agent>.md` replacement file (located according to the Prompt Lookup Precedence).

3. **Append Append Prompt:**
   - If an append file `<agent>_append.md` is resolved, it is appended to the `effectiveBase` separated by two newlines:
     ```
     finalPrompt = effectiveBase + "\n\n" + appendPrompt
     ```
   - Otherwise:
     ```
     finalPrompt = effectiveBase
     ```

---

## Custom Routing Guidance (`orchestratorPrompt`)

Every non-orchestrator agent (both built-in and custom) can define an `orchestratorPrompt`. This snippet is automatically injected into the central **Orchestrator** prompt to instruct it on when and how to delegate tasks to this agent.

- **Additive Routing Guidance:** The local config snippet is grouped under a clear markdown header (`# Project-specific routing guidance`) at the end of the orchestrator prompt. It does not replace the default routing blocks.
- **Display name rewriting:** Any mentions of `@<internalName>` within the `orchestratorPrompt` are automatically mapped to the agent's custom `displayName` if one was defined.
- **Disabled agents:** If an agent is disabled via the `disabled_agents` config option, its `orchestratorPrompt` is **not** injected.
- **Orchestrator agent constraint:** The orchestrator agent itself cannot define an `orchestratorPrompt`. Setting `agents.orchestrator.orchestratorPrompt` will be rejected by the schema.

---

## Examples

### Overriding Oracle prompt in active preset

Your project has the config `.opencode/oh-my-opencode-slim.jsonc`:

```json
{
  "preset": "backend-preset",
  "presets": {
    "backend-preset": {
      "oracle": {
        "model": "anthropic/claude-3-5-sonnet",
        "prompt": "You are the project senior backend oracle. Focus strictly on NestJS."
      }
    }
  }
}
```

If you also place a file under `.opencode/oh-my-opencode-slim/backend-preset/oracle.md` containing:
```
Your primary focus is auditing backend security and performance.
```
According to prompt composition rules, the markdown file prompt overrides the inline preset prompt, so the effective base prompt becomes `"Your primary focus is auditing backend security and performance."`.
