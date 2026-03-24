# Quick Reference Guide

Complete reference for oh-my-opencode-slim configuration and capabilities.

## Table of Contents

- [Presets](#presets)
- [Skills](#skills)
  - [Cartography](#cartography)
- [MCP Servers](#mcp-servers)
- [Tools & Capabilities](#tools--capabilities)
- [Configuration](#configuration)

---

## Presets

The default installer generates an OpenAI preset. To use alternative providers (Kimi, GitHub Copilot, ZAI Coding Plan), see **[Provider Configurations](provider-configurations.md)** for step-by-step instructions and full config examples.

### Switching Presets

**Method 1: Edit Config File**

Edit `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`) and change the `preset` field:

```json
{
  "preset": "openai"
}
```

**Method 2: Environment Variable**

Set the environment variable before running OpenCode:

```bash
export OH_MY_OPENCODE_SLIM_PRESET=openai
opencode
```

The environment variable takes precedence over the config file.

### OpenAI Preset (Default)

Uses OpenAI models exclusively:

```json
{
  "preset": "openai",
  "presets": {
    "openai": {
      "orchestrator": { "model": "openai/gpt-5.4", "skills": ["*"], "mcps": ["websearch"] },
      "oracle": { "model": "openai/gpt-5.4", "variant": "high", "skills": [], "mcps": [] },
      "librarian": { "model": "openai/gpt-5.4-mini", "variant": "low", "skills": [], "mcps": ["websearch", "context7", "grep_app"] },
      "explorer": { "model": "openai/gpt-5.4-mini", "variant": "low", "skills": [], "mcps": [] },
      "designer": { "model": "openai/gpt-5.4-mini", "variant": "medium", "skills": ["agent-browser"], "mcps": [] },
      "fixer": { "model": "openai/gpt-5.4-mini", "variant": "low", "skills": [], "mcps": [] }
    }
  }
}
```

### Other Providers

For Kimi, GitHub Copilot, and ZAI Coding Plan presets, see **[Provider Configurations](provider-configurations.md)**.

### Fallback / Failover

The plugin can fail over from one model to the next when a prompt times out or errors. This is the runtime fallback path used by the background task manager; it is separate from your preset selection.

**How it works:**

- Each agent can have a fallback chain under `fallback.chains.<agent>`
- The active prompt uses the agent's configured model first
- If that model fails, the manager aborts the session, waits briefly, and tries the next model in the chain
- Duplicate model IDs are ignored, so the same model is not retried twice
- If fallback is disabled, the task runs with no failover timeout

**Minimal example:**

```jsonc
{
  "fallback": {
    "enabled": true,
    "timeoutMs": 15000,
    "retryDelayMs": 500,
    "chains": {
      "orchestrator": [
        "openai/gpt-5.4",
        "anthropic/claude-sonnet-4-6",
        "google/gemini-3.1-pro"
      ]
    }
  }
}
```

**Important notes:**

- Fallback models must use the `provider/model` format
- Chains are per agent (`orchestrator`, `oracle`, `designer`, `explorer`, `librarian`, `fixer`)
- If an agent has no configured chain, only its primary model is used
- This is documented here because it is easy to miss in the config file

---

## Skills

Skills are specialized capabilities provided by external agents and tools. Unlike MCPs which are servers, skills are prompt-based tool configurations installed via `npx skills add` during installation.

### Recommended Skills (via npx)

| Skill | Description | Assigned To |
|-------|-------------|-------------|
| [`simplify`](#simplify) | YAGNI code simplification expert | `orchestrator` |
| [`agent-browser`](#agent-browser) | High-performance browser automation | `designer` |

### Custom Skills (bundled in repo)

| Skill | Description | Assigned To |
|-------|-------------|-------------|
| [`cartography`](#cartography) | Repository understanding and hierarchical codemap generation | `orchestrator` |

### Simplify

**The Minimalist's sacred truth: every line of code is a liability.**

`simplify` is a specialized skill for complexity analysis and YAGNI enforcement. It identifies unnecessary abstractions and suggests minimal implementations.

### Agent Browser

**External browser automation for visual verification and testing.**

`agent-browser` provides full high-performance browser automation capabilities. It allows agents to browse the web, interact with elements, and capture screenshots for visual state verification.

### Cartography

**Automated repository mapping through hierarchical codemaps.**

A dedicated guide (with screenshots) lives at: **[docs/cartography.md](cartography.md)**.

`cartography` empowers the Orchestrator to build and maintain a deep architectural understanding of any codebase. Instead of reading thousands of lines of code every time, agents refer to hierarchical `codemap.md` files that describe the *why* and *how* of each directory.

**How to use:**

Just ask the **Orchestrator** to `run cartography`. It will automatically detect if it needs to initialize a new map or update an existing one.

**Why it's useful:**

- **Instant Onboarding:** Help agents (and humans) understand unfamiliar codebases in seconds.
- **Efficient Context:** Agents only read architectural summaries, saving tokens and improving accuracy.
- **Change Detection:** Only modified folders are re-analyzed, making updates fast and efficient.
- **Timeless Documentation:** Focuses on high-level design patterns that don't get stale.

<details>
<summary><b>Technical Details & Manual Control</b></summary>

The skill uses a background Python engine (`cartographer.py`) to manage state and detect changes.

**How it works under the hood:**

1. **Initialize** - Orchestrator analyzes repo structure and runs `init` to create `.slim/cartography.json` (hashes) and empty templates.
2. **Map** - Orchestrator spawns specialized **Explorer** sub-agents to fill codemaps with timeless architectural details (Responsibility, Design, Flow, Integration).
3. **Update** - On subsequent runs, the engine detects changed files and only refreshes codemaps for affected folders.

**Manual Commands:**

```bash
# Initialize mapping manually
python3 ~/.config/opencode/skills/cartography/scripts/cartographer.py init \
  --root . \
  --include "src/**/*.ts" \
  --exclude "**/*.test.ts"

# Check for changes since last map
python3 ~/.config/opencode/skills/cartography/scripts/cartographer.py changes --root .

# Sync hashes after manual map updates
python3 ~/.config/opencode/skills/cartography/scripts/cartographer.py update --root .
```
</details>

### Skills Assignment

You can customize which skills each agent is allowed to use in `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`).

**Syntax:**

| Syntax | Description | Example |
|--------|-------------|---------|
| `"*"` | All installed skills | `["*"]` |
| `"!item"` | Exclude specific skill | `["*", "!agent-browser"]` |
| Explicit list | Only listed skills | `["simplify"]` |
| `"!*"` | Deny all skills | `["!*"]` |

**Rules:**
- `*` expands to all available skills
- `!item` excludes specific skills
- Conflicts (e.g., `["a", "!a"]`) → deny wins (principle of least privilege)
- Empty list `[]` → no skills allowed

**Example Configuration:**

```json
{
  "presets": {
    "my-preset": {
      "orchestrator": {
        "skills": ["*", "!agent-browser"]
      },
      "designer": {
        "skills": ["agent-browser", "simplify"]
      }
    }
  }
}
```

---

## MCP Servers

Built-in Model Context Protocol servers (enabled by default):

| MCP | Purpose | URL |
|-----|---------|-----|
| `websearch` | Real-time web search via Exa AI | `https://mcp.exa.ai/mcp` |
| `context7` | Official library documentation | `https://mcp.context7.com/mcp` |
| `grep_app` | GitHub code search via grep.app | `https://mcp.grep.app` |

### MCP Permissions

Control which agents can access which MCP servers using per-agent allowlists:

| Agent | Default MCPs |
|-------|--------------|
| `orchestrator` | `websearch` |
| `designer` | none |
| `oracle` | none |
| `librarian` | `websearch`, `context7`, `grep_app` |
| `explorer` | none |
| `fixer` | none |

### Configuration & Syntax

You can configure MCP access in your plugin configuration file: `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`).

**Per-Agent Permissions**

Control which agents can access which MCP servers using the `mcps` array in your preset. The syntax is the same as for skills:

| Syntax | Description | Example |
|--------|-------------|---------|
| `"*"` | All MCPs | `["*"]` |
| `"!item"` | Exclude specific MCP | `["*", "!context7"]` |
| Explicit list | Only listed MCPs | `["websearch", "context7"]` |
| `"!*"` | Deny all MCPs | `["!*"]` |

**Rules:**
- `*` expands to all available MCPs
- `!item` excludes specific MCPs
- Conflicts (e.g., `["a", "!a"]`) → deny wins
- Empty list `[]` → no MCPs allowed

**Example Configuration:**

```json
{
  "presets": {
    "my-preset": {
      "orchestrator": {
        "mcps": ["websearch"]
      },
      "librarian": {
        "mcps": ["websearch", "context7", "grep_app"]
      },
      "oracle": {
        "mcps": ["*", "!websearch"]
      }
    }
  }
}
```

**Global Disabling**

You can disable specific MCP servers globally by adding them to the `disabled_mcps` array at the root of your config object.

---

## Tools & Capabilities

### Tmux Integration

**Watch your agents work in real-time.** When the Orchestrator launches sub-agents or initiates background tasks, new tmux panes automatically spawn showing each agent's live progress. No more waiting in the dark.

#### Quick Setup

1. **Enable tmux integration** in `oh-my-opencode-slim.json` (or `.jsonc`):

   ```json
   {
     "tmux": {
       "enabled": true,
       "layout": "main-vertical",
       "main_pane_size": 60
     }
   }
   ```

2. **Run OpenCode inside tmux**:
    ```bash
    tmux
    opencode
    ```

#### Layout Options

| Layout | Description |
|--------|-------------|
| `main-vertical` | Your session on the left (60%), agents stacked on the right |
| `main-horizontal` | Your session on top (60%), agents stacked below |
| `tiled` | All panes in equal-sized grid |
| `even-horizontal` | All panes side by side |
| `even-vertical` | All panes stacked vertically |

> **Detailed Guide:** For complete tmux integration documentation, troubleshooting, and advanced usage, see [Tmux Integration](tmux-integration.md)

### Background Tasks

The plugin provides tools to manage asynchronous work:

| Tool | Description |
|------|-------------|
| `background_task` | Launch an agent in a new session (`sync=true` blocks, `sync=false` runs in background) |
| `background_output` | Fetch the result of a background task by ID |
| `background_cancel` | Abort running tasks |

### LSP Tools

Language Server Protocol integration for code intelligence:

| Tool | Description |
|------|-------------|
| `lsp_goto_definition` | Jump to symbol definition |
| `lsp_find_references` | Find all usages of a symbol across the workspace |
| `lsp_diagnostics` | Get errors/warnings from the language server |
| `lsp_rename` | Rename a symbol across all files |

> **Built-in LSP Servers:** OpenCode includes pre-configured LSP servers for 30+ languages (TypeScript, Python, Rust, Go, etc.). See the [official documentation](https://opencode.ai/docs/lsp/#built-in) for the full list and requirements.

### Code Search Tools

Fast code search and refactoring:

| Tool | Description |
|------|-------------|
| `grep` | Fast content search using ripgrep |
| `ast_grep_search` | AST-aware code pattern matching (25 languages) |
| `ast_grep_replace` | AST-aware code refactoring with dry-run support |

### Formatters

OpenCode automatically formats files after they're written or edited using language-specific formatters.

> **Built-in Formatters:** Includes support for Prettier, Biome, gofmt, rustfmt, ruff, and 20+ others. See the [official documentation](https://opencode.ai/docs/formatters/#built-in) for the complete list.

---

## Configuration

### Files You Edit

| File | Purpose |
|------|---------|
| `~/.config/opencode/opencode.json` | OpenCode core settings |
| `~/.config/opencode/oh-my-opencode-slim.json` or `.jsonc` | Plugin settings (agents, tmux, MCPs) |
| `.opencode/oh-my-opencode-slim.json` or `.jsonc` | Project-local plugin overrides (optional) |

> **💡 JSONC Support:** Configuration files support JSONC format (JSON with Comments). Use `.jsonc` extension to enable comments and trailing commas. If both `.jsonc` and `.json` exist, `.jsonc` takes precedence.

### Prompt Overriding

You can customize agent prompts by creating markdown files in `~/.config/opencode/oh-my-opencode-slim/`:

- With no preset, prompt files are loaded directly from this directory.
- With `preset` set (for example `test`), the plugin first checks `~/.config/opencode/oh-my-opencode-slim/{preset}/`, then falls back to the root prompt directory.

| File | Purpose |
|------|---------|
| `{agent}.md` | Replaces the default prompt entirely |
| `{agent}_append.md` | Appends to the default prompt |

**Example:**

```
~/.config/opencode/oh-my-opencode-slim/
  ├── test/
  │   ├── orchestrator.md      # Preset-specific override (preferred)
  │   └── explorer_append.md
  ├── orchestrator.md          # Custom orchestrator prompt
  ├── orchestrator_append.md   # Append to default orchestrator prompt
  ├── explorer.md
  ├── explorer_append.md
  └── ...
```

**Usage:**

- Create `{agent}.md` to completely replace an agent's default prompt
- Create `{agent}_append.md` to add custom instructions to the default prompt
- Both files can exist simultaneously - the replacement takes precedence
- When `preset` is set, `{preset}/{agent}.md` and `{preset}/{agent}_append.md` are checked first
- If neither file exists, the default prompt is used

This allows you to fine-tune agent behavior without modifying the source code.

### JSONC Format (JSON with Comments)

The plugin supports **JSONC** format for configuration files, allowing you to:

- Add single-line comments (`//`)
- Add multi-line comments (`/* */`)
- Use trailing commas in arrays and objects

**File Priority:**
1. `oh-my-opencode-slim.jsonc` (preferred if exists)
2. `oh-my-opencode-slim.json` (fallback)

**Example JSONC Configuration:**

```jsonc
{
  // Use preset for development
  "preset": "openai",

  /* Presets definition - customize agent models here */
  "presets": {
    "openai": {
      // Fast models for quick iteration
      "oracle": { "model": "openai/gpt-5.4" },
      "explorer": { "model": "openai/gpt-5.4-mini" },
    },
  },

  "tmux": {
    "enabled": true,  // Enable for monitoring
    "layout": "main-vertical",
  },
}
```

### Plugin Config (`oh-my-opencode-slim.json` or `oh-my-opencode-slim.jsonc`)

The installer generates this file with the OpenAI preset by default. You can manually customize it to mix and match models from any provider. See [Provider Configurations](provider-configurations.md) for examples.

#### Option Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `preset` | string | - | Name of the preset to use (e.g., `"openai"`, `"kimi"`) |
| `presets` | object | - | Named preset configurations containing agent mappings |
| `presets.<name>.<agent>.model` | string | - | Model ID for the agent (e.g., `"openai/gpt-5.4"`) |
| `presets.<name>.<agent>.temperature` | number | - | Temperature setting (0-2) for the agent |
| `presets.<name>.<agent>.variant` | string | - | Agent variant for reasoning effort (e.g., `"low"`, `"medium"`, `"high"`) |
| `presets.<name>.<agent>.skills` | string[] | - | Array of skill names the agent can use (`"*"` for all, `"!item"` to exclude) |
| `presets.<name>.<agent>.mcps` | string[] | - | Array of MCP names the agent can use (`"*"` for all, `"!item"` to exclude) |
| `tmux.enabled` | boolean | `false` | Enable tmux pane spawning for sub-agents |
| `tmux.layout` | string | `"main-vertical"` | Layout preset: `main-vertical`, `main-horizontal`, `tiled`, `even-horizontal`, `even-vertical` |
| `tmux.main_pane_size` | number | `60` | Main pane size as percentage (20-80) |
| `disabled_mcps` | string[] | `[]` | MCP server IDs to disable globally (e.g., `"websearch"`) |
