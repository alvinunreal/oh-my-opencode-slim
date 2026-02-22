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

Presets are pre-configured agent model mappings for different provider combinations. The installer generates these automatically based on your available providers, and you can switch between them instantly.

### OpenCode Free Discovery

The installer can discover the latest OpenCode free models by running:

```bash
opencode models --refresh --verbose
```

Selection rules:
- Only free `opencode/*` models are considered.
- A coding-first primary model is selected for orchestration/strategy workloads.
- A support model is selected for research/implementation workloads.
- OpenCode-only mode can assign multiple OpenCode models across agents.
- Hybrid mode can combine OpenCode free models with OpenAI/Kimi/Antigravity; `designer` remains on the external provider mapping.

Useful flags:

```bash
--opencode-free=yes|no
--opencode-free-model=<id|auto>
```

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

### OpenAI Preset

Uses OpenAI models exclusively:

```json
{
  "preset": "openai",
  "presets": {
    "openai": {
      "orchestrator": { "model": "openai/gpt-5.2-codex", "skills": ["*"], "mcps": ["websearch"] },
      "oracle": { "model": "openai/gpt-5.2-codex", "variant": "high", "skills": [], "mcps": [] },
      "librarian": { "model": "openai/gpt-5.1-codex-mini", "variant": "low", "skills": [], "mcps": ["websearch", "context7", "grep_app"] },
      "explorer": { "model": "openai/gpt-5.1-codex-mini", "variant": "low", "skills": [], "mcps": [] },
      "designer": { "model": "openai/gpt-5.1-codex-mini", "variant": "medium", "skills": ["agent-browser"], "mcps": [] },
      "fixer": { "model": "openai/gpt-5.1-codex-mini", "variant": "low", "skills": [], "mcps": [] }
    }
  }
}
```

### Google Provider (Antigravity)

Access Claude 4.5 and Gemini 3 models through Google's Antigravity infrastructure.

**Installation:**
```bash
bunx oh-my-opencode-slim install --antigravity=yes --opencode-free=yes --opencode-free-model=auto
```

**Agent Mapping:**
- Orchestrator: Kimi (if available)
- Oracle: GPT (if available)
- Explorer/Librarian/Designer/Fixer: Gemini 3 Flash via Antigravity
- If OpenCode free mode is enabled, Explorer/Librarian/Fixer may use selected free `opencode/*` support model while `designer` stays on external mapping

**Authentication:**
```bash
opencode auth login
# Select "google" provider
```

**Available Models:**
- `google/antigravity-gemini-3-flash`
- `google/antigravity-gemini-3.1-pro`
- `google/antigravity-claude-sonnet-4-5`
- `google/antigravity-claude-sonnet-4-5-thinking`
- `google/antigravity-claude-opus-4-5-thinking`
- `google/gemini-2.5-flash` (Gemini CLI)
- `google/gemini-2.5-pro` (Gemini CLI)
- `google/gemini-3-flash-preview` (Gemini CLI)
- `google/gemini-3.1-pro-preview` (Gemini CLI)

### Author's Preset

Mixed setup combining multiple providers:

```json
{
  "preset": "alvin",
  "presets": {
    "alvin": {
      "orchestrator": { "model": "google/claude-opus-4-5-thinking", "skills": ["*"], "mcps": ["*"] },
      "oracle": { "model": "openai/gpt-5.2-codex", "variant": "high", "skills": [], "mcps": [] },
      "librarian": { "model": "google/gemini-3-flash", "variant": "low", "skills": [], "mcps": ["websearch", "context7", "grep_app"] },
      "explorer": { "model": "cerebras/zai-glm-4.7", "variant": "low", "skills": [], "mcps": [] },
      "designer": { "model": "google/gemini-3-flash", "variant": "medium", "skills": ["agent-browser"], "mcps": [] },
      "fixer": { "model": "cerebras/zai-glm-4.7", "variant": "low", "skills": [], "mcps": [] }
    }
  }
}
```

> **Antigravity Provider:** For complete Antigravity setup guide, see [Antigravity Setup](antigravity.md)

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

> ⚠️ **Temporary workaround:** Start OpenCode with `--port` to enable tmux integration. The port must match the `OPENCODE_PORT` environment variable (default: 4096). This is required until the upstream issue is resolved. [opencode#9099](https://github.com/anomalyco/opencode/issues/9099).

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
    opencode --port 4096
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

| File | Purpose |
|------|---------|
| `{agent}.md` | Replaces the default prompt entirely |
| `{agent}_append.md` | Appends to the default prompt |

**Example:**

```
~/.config/opencode/oh-my-opencode-slim/
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
  "preset": "dev",

  /* Presets definition - customize agent models here */
  "presets": {
    "dev": {
      // Fast models for quick iteration
      "oracle": { "model": "google/gemini-3-flash" },
      "explorer": { "model": "google/gemini-3-flash" },
    },
  },

  "tmux": {
    "enabled": true,  // Enable for monitoring
    "layout": "main-vertical",
  },
}
```

### Plugin Config (`oh-my-opencode-slim.json` or `oh-my-opencode-slim.jsonc`)

The installer generates this file based on your providers. You can manually customize it to mix and match models. See the [Presets](#presets) section for detailed configuration options.

#### Option Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `preset` | string | - | Name of the preset to use (e.g., `"openai"`, `"antigravity"`) |
| `presets` | object | - | Named preset configurations containing agent mappings |
| `presets.<name>.<agent>.model` | string | - | Model ID for the agent (e.g., `"google/claude-opus-4-5-thinking"`) |
| `presets.<name>.<agent>.temperature` | number | - | Temperature setting (0-2) for the agent |
| `presets.<name>.<agent>.variant` | string | - | Agent variant for reasoning effort (e.g., `"low"`, `"medium"`, `"high"`) |
| `presets.<name>.<agent>.skills` | string[] | - | Array of skill names the agent can use (`"*"` for all, `"!item"` to exclude) |
| `presets.<name>.<agent>.mcps` | string[] | - | Array of MCP names the agent can use (`"*"` for all, `"!item"` to exclude) |
| `tmux.enabled` | boolean | `false` | Enable tmux pane spawning for sub-agents |
| `tmux.layout` | string | `"main-vertical"` | Layout preset: `main-vertical`, `main-horizontal`, `tiled`, `even-horizontal`, `even-vertical` |
| `tmux.main_pane_size` | number | `60` | Main pane size as percentage (20-80) |
| `disabled_mcps` | string[] | `[]` | MCP server IDs to disable globally (e.g., `"websearch"`) |

> **Note:** Agent configuration should be defined within `presets`. The root-level `agents` field is deprecated.
