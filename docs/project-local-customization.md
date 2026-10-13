# Project-local Customization

This document describes how to configure and customize oh-my-opencode-slim on a per-project (repository-specific) basis. Project-local customization lets teams and repositories define custom agents, override systemic prompts, restrict skills, and set MCP configurations without affecting global user configurations.

## Security & Trust Boundary Warning

> ⚠️ **IMPORTANT SECURITY NOTICE**
> Because project-local configuration files (`.opencode/oh-my-opencode-slim.jsonc`) and prompt templates (`.opencode/oh-my-opencode-slim/`) are loaded automatically when you open and work in a project directory, they can modify agent behaviors, enable/disable tools, and grant extra model access permissions.
> **Only work in and run OpenCode within repositories you explicitly trust.**

Configuration discovery also includes `.opencode/oh-my-opencode-slim.json[c]`
in eligible ancestor directories. This matches the host's discovery: v2 walks
through the filesystem root, even above repository and worktree boundaries;
v1 stops at the Git worktree boundary, inclusive, or the filesystem root when
there is no Git boundary. Prompt files and optional local skill grants use the
same walk. `OPENCODE_DISABLE_PROJECT_CONFIG=true` or `1` disables that project
walk, leaving user configuration available. Review and trust ancestor
directories too. On v2, `~/.opencode` is a project layer for projects under
`$HOME` and overrides matching `~/.config/opencode` settings; on v1 it must be
within the worktree walk to be inherited.

The implementation references are OpenCode v1's
[ConfigPaths.directories](https://github.com/anomalyco/opencode/blob/v1.18.13/packages/opencode/src/config/paths.ts)
and OpenCode 2.0.22's
[ConfigDiscovery](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/config/discovery.ts)
and its [filesystem walk](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/util/src/fs-util.ts).

---

## Feature Comparison

| Feature | Scope / Location | Description |
|---|---|---|
| **Configuration file** | `.opencode/oh-my-opencode-slim.json[c]` | Project-level configuration file that overrides global user settings, merging presets, agent profiles, and multiplexer integration. |
| **Custom agents** | `agents` configuration block | Define new specialized agents by keying them under `agents.<custom-name>` with required `model`, custom system `prompt`, and optional routing guidance. |
| **Built-in prompt overrides** | `.opencode/oh-my-opencode-slim/<agent>.md` | Override the built-in system prompt for any agent (e.g. `oracle.md`, `explorer.md`, `orchestrator.md`, or custom agents). Acts as the default when no inline `prompt` is set in config. |
| **Append prompts** | `.opencode/oh-my-opencode-slim/<agent>_append.md` | Append additional rules or guidelines to the existing base (inline, file, or default built-in) prompt without overriding it completely. |
| **Per-agent skills** | `agents.<agent>.skills` | Explicitly restrict or authorize specific local codebase skills/scripts that this agent is allowed to execute. |
| **Automatic project-local skills** | `agents.<agent>.skills_include_local` | Add valid skills from current and ancestor `.opencode/skills/**/SKILL.md` and `.agents/skills/**/SKILL.md` trees without listing every skill name. |
| **Per-agent MCPs** | `agents.<agent>.mcps` | Assign, restrict, or authorize specific Model Context Protocol (MCP) servers (like `context7` or `gh_grep`) to specific agents. |
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
[Ancestor Project Configs] (host boundary to current directory)
       ↓ (overridden by)
[Environment Preset Override] (via OH_MY_OPENCODE_SLIM_PRESET env var)
       ↓ (merged into agents)
[Active Preset] (merges preset-specific agent options)
       ↓ (overridden by)
[Root Config agents.*] (individual agent configs beat preset configurations)
```

### Note on Root Overrides vs Presets

Each ancestor layer merges before the next closer layer. A nested project or
worktree can override selected agent fields without duplicating the shared
configuration above it. Within each directory, `.jsonc` takes precedence over
`.json`; sibling directories are not searched.

The root `agents.*` configuration (defined at the top level of user or project config) always takes precedence over the active preset configurations. To override a root agent choice globally, you must specify the override in the project-level root `agents.*` rather than inside a local preset configuration alone.

---

## Additive and Subtractive Skill Configuration

The `skills` array is replacement-based: when a project config defines `agents.<agent>.skills`, it replaces the inherited list wholesale. To add project-specific skills on top of an inherited list — or remove inherited skills — without duplicating that list, use the `skills_add` and `skills_remove` directives:

```jsonc
// ~/.config/opencode/oh-my-opencode-slim.jsonc (global)
{
  "agents": {
    "oracle": {
      "skills": ["codemap", "deepwork"]
    }
  }
}
```

```jsonc
// <project>/.opencode/oh-my-opencode-slim.jsonc (project-local)
{
  "agents": {
    "oracle": {
      "skills_add": ["project-architecture", "project-testing"]
    }
  }
}
```

Effective result: `codemap`, `deepwork`, `project-architecture`, `project-testing` — the global list is not duplicated.

Resolution order is deterministic: resolve the inherited/configured `skills` list, then apply `skills_add`, then apply `skills_remove`. Duplicates are removed (first occurrence wins), and `skills_remove` wins over `skills_add` for the same skill. When the effective list contains `"*"`, removals are expressed with the existing `!name` exclusion syntax (e.g. effective `["*", "!codemap"]`). The directives are folded into `skills` during agent resolution — after all layers (user config, project config, presets, runtime `/preset` switching) have determined the effective `skills` value — and stripped from the final agent configuration, so agent definitions and hooks only ever see a plain `skills` list. On an agent without a `skills` list, directives resolve against that agent's default grants, so `skills_add` keeps the defaults and appends.

See [Skills Assignment](skills.md#adding-or-removing-skills-on-top-of-an-inherited-list) for the full rule set, including behavior when no `skills` list is configured.

### Including all project-local skills automatically

When a repository carries several project skills under `.opencode/skills` or `.agents/skills`, set `skills_include_local: true` instead of repeating every local skill name in `skills_add`:

```text
.opencode/skills/
└── project-architecture/SKILL.md  # name: project-architecture
.agents/skills/
├── project-testing/SKILL.md       # name: project-testing
└── project-release/SKILL.md       # name: project-release
```

```jsonc
// <project>/.opencode/oh-my-opencode-slim.jsonc
{
  "agents": {
    "oracle": {
      "skills_include_local": true
    }
  }
}
```

The flag behaves like automatically adding every valid skill discovered under
the current and ancestor `.opencode/skills/**/SKILL.md` and
`.agents/skills/**/SKILL.md` trees within the host's discovery boundary.
Duplicate names across both roots are granted once; sibling trees are not
searched. OpenCode selects which actual skill is loaded. Skill identity comes
from the `name` frontmatter field, not the directory name.
The option works in global user config and may be overridden per project.
This matches OpenCode's ancestor directory discovery, not every host-specific
skill format. OpenCode v2 uses path-derived IDs, so keep the frontmatter name
equal to the skill directory name when using this flag on v2. If another local
`SKILL.md` is added later, it is picked up on reload without another config
edit.

It composes with the existing directives. For example, include all project-local skills but exclude one from `fixer`:

```jsonc
{
  "agents": {
    "fixer": {
      "skills_include_local": true,
      "skills_remove": ["project-release"]
    }
  }
}
```

`skills_remove` still wins over automatically included local skills. Global
skills, other compatibility directories, configured external paths, and URL
skill sources are intentionally outside this flag's scope. The existing safety
checks remain: symlinked `.opencode`, `.agents`, or `skills` roots pointing
outside their ancestor location are skipped, and symlinked skill entries are
not followed.
OpenCode itself remains responsible for registering and loading skills.

---

## Prompt Lookup Precedence

When looking up markdown prompt template files (such as `<agent>.md` or `<agent>_append.md`), oh-my-opencode-slim searches directories in a strict hierarchical order. Precedence is evaluated for the replacement prompt file and the append prompt file **independently** in the following sequence:

1. **Project Preset Directory**
   `<project>/.opencode/oh-my-opencode-slim/<preset>/<agent>.md` (if preset is active and safe)
2. **Project Root Directory**
   `<project>/.opencode/oh-my-opencode-slim/<agent>.md`
3. **Ancestor Directories, Nearest First**
   Repeat the preset-directory then root-directory lookup in each ancestor's
   `.opencode/oh-my-opencode-slim/`, through the host's boundary. A nearer root
   prompt beats a farther preset-specific prompt.
4. **User Preset Directory (Global)**
   `<user-config-dir>/oh-my-opencode-slim/<preset>/<agent>.md`
5. **User Root Directory (Global)**
   `<user-config-dir>/oh-my-opencode-slim/<agent>.md`

Replacement and append files can come from different levels. Only the first
matching file of each kind is used; ancestor append files are not concatenated.
Inline prompt precedence and the composition rules below are unchanged.

---

## Prompt Composition Rules

For any agent, the final system prompt is computed dynamically. Precedence
is **inline > file > built-in default**:

1. **Resolve the effective base prompt:**
   ```
   effectiveBase = inlinePrompt ?? filePrompt ?? defaultBuiltInPrompt
   ```
   - `inlinePrompt` is the `prompt` string set directly in
     `agents.<agent>.prompt` (config or preset).
   - `filePrompt` is the content of the resolved `<agent>.md` replacement
     file (located according to the Prompt Lookup Precedence).
   - `defaultBuiltInPrompt` is the agent's factory template (built-in
     agents) or `"You are the <name> specialist."` (custom agents).

   An explicit inline `prompt` always wins over a prompt file. The file
   acts as a shared default — useful for the "shared prompt, per-preset
   model" pattern where the file holds the common base and each preset
   only overrides `model` and `variant`.

2. **Conflict warning:**
   When both an inline `prompt` and a `<agent>.md` file exist, a
   `console.warn` is emitted at agent construction:
   ```
   [oh-my-opencode] Agent '<name>': inline prompt overrides prompt file
   (<name>.md). Remove the inline prompt to use the file.
   ```
   This is informational — the inline prompt takes effect as expected. The
   warning surfaces the conflict so you know the file is being ignored.

3. **Append prompt:**
   - If an append file `<agent>_append.md` is resolved, it is appended to
     the `effectiveBase` separated by two newlines:
     ```
     finalPrompt = effectiveBase + "\n\n" + appendPrompt
     ```
   - Otherwise:
     ```
     finalPrompt = effectiveBase
     ```

### Host Vocabulary in Custom Prompts

Prompt text you supply is used **verbatim** for delegation vocabulary — the
plugin never rewrites delegation calls in it (`task(...)` on v1,
`subagent(...)` on v2). Separately, display-name substitution rewrites
`@<internalName>` mentions to the agent's `displayName` throughout the final
orchestrator prompt (inline, file, and append orchestrator prompts) and in
`orchestratorPrompt`/ACP routing snippets (see
[Display name rewriting](#custom-routing-guidance-orchestratorprompt) below).
The host you run on therefore determines the delegation vocabulary embedded in
that text:

| Host (plugin entry) | Delegation call | Agent param | Resume param |
|---|---|---|---|
| v1 (`opencode`) | `task(...)` | `subagent_type` | `task_id` |
| v2 (`opencode2`) | `subagent(...)` | `agent` | `sessionID` |

This applies to **every** prompt you supply:

- inline `agents.<agent>.prompt`,
- `<agent>.md` replacement and `<agent>_append.md` files,
- `orchestratorPrompt` routing snippets,
- custom and ACP agent prompts,
- council `presets.<name>.<councillor>.prompt` guidance.

A prompt that hard-codes delegation calls is therefore **not portable** between
v1 and v2 — keep a host-specific version for each.

The control-tool names (`task_status`, `task_result`, `task_message`,
`task_reply`, `task_revive`, `task_cancel`) are identical on both hosts. On v2
they take `sessionID` and also accept `task_id` as a deprecated alias (never
emitted).

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
The inline preset `prompt` takes precedence over the file, so the effective
base prompt becomes `"You are the project senior backend oracle. Focus
strictly on NestJS."`. A `console.warn` fires noting the file is being
overridden. To use the file prompt instead, remove the inline `prompt` from
the preset config.
