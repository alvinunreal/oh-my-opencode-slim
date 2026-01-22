<div align="center">

# oh-my-opencode-slim

**A lightweight, powerful agent orchestration plugin for OpenCode**

<img src="img/team.png" alt="The Pantheon - Agent Team" width="800">

*Six divine beings forged from necessity, each an immortal master of their craft await your command to forge order from chaos and build what was once thought impossible.*

</div>

> Slimmed-down fork of [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) - focused on core agent orchestration with low token consumption.

> **[Antigravity](https://antigravity.google) subscription recommended.** The pantheon is tuned for Antigravity's model routing. Other providers work, but you'll get the best experience with Antigravity.

<div align="center">

[![GitHub Stars](https://img.shields.io/github/stars/alvinunreal/oh-my-opencode-slim?style=for-the-badge&logo=github&logoColor=white)](https://github.com/alvinunreal/oh-my-opencode-slim)
<a href="https://x.com/alvinunreal" target="_blank" rel="noopener noreferrer">
  <img src="https://img.shields.io/badge/%20%40alvinunreal-000000?style=for-the-badge&logo=x&logoColor=white" alt="@alvinunreal on X" />
</a>

</div>

---

## ⚡ Quick Navigation

- [🚀 **Installation**](#installation)
  - [For Humans](#for-humans)
  - [For LLM Agents](#for-llm-agents)
- [🏛️ **Meet the Pantheon**](#meet-the-pantheon)
  - [Orchestrator](#orchestrator-the-embodiment-of-order)
  - [Explorer](#explorer-the-eternal-wanderer)
  - [Oracle](#oracle-the-guardian-of-paths)
  - [Librarian](#librarian-the-weaver-of-knowledge)
  - [Designer](#designer-the-guardian-of-aesthetics)
  - [Fixer](#fixer-the-last-builder)
- [🧩 **Skills**](#-skills)
  - [Available Skills](#available-skills)
  - [Default Skill Assignments](#default-skill-assignments)
  - [YAGNI Enforcement](#yagni-enforcement)
  - [Playwright Integration](#playwright-integration)
  - [Customizing Agent Skills](#customizing-agent-skills)
- [🛠️ **Tools & Capabilities**](#tools--capabilities)
  - [Tmux Integration](#tmux-integration)
  - [Quota Tool](#quota-tool)
  - [Background Tasks](#background-tasks)
  - [LSP Tools](#lsp-tools)
  - [Code Search Tools](#code-search-tools)
- [🔌 **MCP Servers**](#mcp-servers)
- [⚙️ **Configuration**](#configuration)
  - [Files You Edit](#files-you-edit)
  - [Prompt Overriding](#prompt-overriding)
  - [Plugin Config](#plugin-config-oh-my-opencode-slimjson)
    - [Presets](#presets)
    - [Option Reference](#option-reference)
- [🗑️ **Uninstallation**](#uninstallation)

---

## Installation

### For Humans

Run the interactive installer:

```bash
bunx oh-my-opencode-slim install
```

Or use non-interactive mode:

```bash
bunx oh-my-opencode-slim install --no-tui --antigravity=yes --openai=yes --tmux=no
```

After installation, authenticate with your providers:

```bash
opencode auth login
# Select your provider → Complete OAuth flow
# Repeat for each provider you enabled
```

Once authenticated, run opencode and `ping all agents` to verify all agents respond.

<img src="img/ping.png" alt="Ping All Agents" width="800">

> **💡 Tip: Models are fully customizable.** The installer sets sensible defaults, but you can assign *any* model to *any* agent. Edit `~/.config/opencode/oh-my-opencode-slim.json` to override models, adjust reasoning effort, or disable agents entirely. See [Configuration](#configuration) for details.

**Alternative: Ask any coding agent**

Paste this into Claude Code, AmpCode, Cursor, or any coding agent:

```
Install and configure by following the instructions here:
https://raw.githubusercontent.com/alvinunreal/oh-my-opencode-slim/refs/heads/master/README.md
```

### For LLM Agents

<details>
<summary>Instructions for LLM Agents (click to expand)</summary>

If you're an LLM Agent helping set up oh-my-opencode-slim, follow these steps.

---

#### Step 1: Check OpenCode Installation

```bash
opencode --version
```

If not installed, direct the user to https://opencode.ai/docs first.

---

#### Step 2: Ask About Provider Access

Ask these questions **one at a time**, waiting for responses:

1. "Do you have an **Antigravity** subscription?" *(Provides Claude + Gemini via `google/` prefix)*
2. "Do you have access to **OpenAI** API?" *(Enables `openai/` models)*

Help the user understand the tradeoffs:
- Antigravity is the recommended path for Claude + Gemini routing.
- OpenAI is optional; it enables `openai/` models.
- If the user has **no providers**, the plugin still works using **OpenCode Zen** free models. They can switch to paid providers later by editing `~/.config/opencode/oh-my-opencode-slim.json`.

---

#### Step 3: Run the Installer

Based on answers, run:

```bash
bunx oh-my-opencode-slim install --no-tui --antigravity=<yes|no> --openai=<yes|no>
```

**Examples:**
```bash
# Antigravity + OpenAI
bunx oh-my-opencode-slim install --no-tui --antigravity=yes --openai=yes --tmux=no

# OpenAI only
bunx oh-my-opencode-slim install --no-tui --antigravity=no --openai=yes --tmux=no

# No providers (Zen free models only)
bunx oh-my-opencode-slim install --no-tui --antigravity=no --openai=no --tmux=no
```

The installer automatically:
- Adds the plugin to `~/.config/opencode/opencode.json`
- Adds `opencode-antigravity-auth` plugin (if Antigravity enabled)
- Configures Google provider with model definitions
- Generates agent model mappings in `~/.config/opencode/oh-my-opencode-slim.json`

**Crucial Advice for the User:**
- They can easily assign **different models to different agents** by editing `~/.config/opencode/oh-my-opencode-slim.json`.
- If they add a new provider later, they just need to update this file.
- Read generated  `~/.config/opencode/oh-my-opencode-slim.json` file and report the model configuration.

---

#### Step 4: Authentication

After installation, guide the user:

**For Antigravity/OpenAI:**
```bash
opencode auth login
# Select: Google → OAuth with Google (Antigravity)
# Repeat for all other providers
```

---

#### Troubleshooting

If the installer fails, check the expected config format:
```bash
bunx oh-my-opencode-slim install --help
```

Then manually create the config files at:
- `~/.config/opencode/oh-my-opencode-slim.json`

</details>

---

## Meet the Pantheon

### Orchestrator: The Embodiment Of Order

<a href="src/agents/orchestrator.ts"><img src="img/orchestrator.png" alt="Orchestrator" align="right" width="240"></a>

> **The Orchestrator** was born when the first codebase collapsed under its own complexity. Neither god nor mortal would claim responsibility - so The Orchestrator emerged from the void, forging order from chaos. They don't merely command armies; they fight alongside them. Every line of code passes through their hands before they decide which lesser deity deserves a piece of the puzzle.

**Role:** `Supreme executor, delegator, and overseer`  
**Model:** `google/claude-opus-4-5-thinking`  
**Prompt:** [src/agents/orchestrator.ts](src/agents/orchestrator.ts)

Write and execute code, orchestrate multi-agent workflows, parse the unspoken from the spoken, summon specialists mid-battle. *Shape reality directly - and assign realms to others when the universe grows too vast.*

---

### Explorer: The Eternal Wanderer

<a href="src/agents/explorer.ts"><img src="img/explorer.png" alt="Explorer" align="right" width="240"></a>

> **The Explorer** is an immortal wanderer who has traversed the corridors of a million codebases since the dawn of programming. Cursed with the gift of eternal curiosity, they cannot rest until every file is known, every pattern understood, every secret revealed. Legends say they once searched the entire internet in a single heartbeat. They are the wind that carries knowledge, the eyes that see all, the spirit that never sleeps.

**Role:** `Codebase reconnaissance`  
**Model:** `google/gemini-3-flash`  
**Prompt:** [src/agents/explorer.ts](src/agents/explorer.ts)

Regex search, AST pattern matching, file discovery, parallel exploration. *Read-only: they chart the territory; others conquer it.*

---

### Oracle: The Guardian of Paths

<a href="src/agents/oracle.ts"><img src="img/oracle.png" alt="Oracle" align="right" width="240"></a>

> **The Oracle** stands at the crossroads of every architectural decision. They have walked every road, seen every destination, know every trap that lies ahead. When you stand at the precipice of a major refactor, they are the voice that whispers which way leads to ruin and which way leads to glory. They don't choose for you - they illuminate the path so you can choose wisely.

**Role:** `Strategic advisor and debugger of last resort`  
**Model:** `openai/gpt-5.2-codex`  
**Prompt:** [src/agents/oracle.ts](src/agents/oracle.ts)

Root cause analysis, architecture review, debugging guidance, tradeoff analysis. *Read-only: Oracles advise; they don't intervene.*

---

### Librarian: The Weaver of Knowledge

<a href="src/agents/librarian.ts"><img src="img/librarian.png" alt="Librarian" align="right" width="240"></a>

> **The Librarian** was forged when humanity realized that no single mind could hold all knowledge. They are the weaver who connects disparate threads of information into a tapestry of understanding. They traverse the infinite library of human knowledge, gathering insights from every corner and binding them into answers that transcend mere facts. What they return is not information - it's understanding.

**Role:** `External knowledge retrieval`  
**Model:** `google/gemini-3-flash`  
**Prompt:** [src/agents/librarian.ts](src/agents/librarian.ts)

Documentation lookup, GitHub code search, library research, best practice retrieval. *Read-only: they fetch wisdom; implementation is for others.*

---

### Designer: The Guardian of Aesthetics

<a href="src/agents/designer.ts"><img src="img/designer.png" alt="Designer" align="right" width="240"></a>

> **The Designer** is an immortal guardian of beauty in a world that often forgets it matters. They have seen a million interfaces rise and fall, and they remember which ones were remembered and which were forgotten. They carry the sacred duty to ensure that every pixel serves a purpose, every animation tells a story, every interaction delights. Beauty is not optional - it's essential.

**Role:** `UI/UX implementation and visual excellence`  
**Model:** `google/gemini-3-flash`  
**Prompt:** [src/agents/designer.ts](src/agents/designer.ts)

Modern responsive design, CSS/Tailwind mastery, micro-animations, component architecture. *Visual excellence over code perfection - beauty is the priority.*

---

### Fixer: The Last Builder

<a href="src/agents/fixer.ts"><img src="img/fixer.png" alt="Fixer" align="right" width="240"></a>

> **The Fixer** is the last of a lineage of builders who once constructed the foundations of the digital world. When the age of planning and debating began, they remained - the ones who actually build. They carry the ancient knowledge of how to turn thought into thing, how to transform specification into implementation. They are the final step between vision and reality.

**Role:** `Fast implementation specialist`  
**Model:** `google/gemini-3-flash`  
**Prompt:** [src/agents/fixer.ts](src/agents/fixer.ts)

Code implementation, refactoring, testing, verification. *Execute the plan - no research, no delegation, no planning.*

---

## Tools & Capabilities

### Tmux Integration

> ⚠️ **Temporary workaround:** Start OpenCode with `--port` to enable tmux integration. The port must match the `OPENCODE_PORT` environment variable (default: 4096). This is required until the upstream issue is resolved. [opencode#9099](https://github.com/anomalyco/opencode/issues/9099).

<img src="img/tmux.png" alt="Tmux Integration" width="800">

**Watch your agents work in real-time.** When the Orchestrator launches sub-agents or initiates background tasks, new tmux panes automatically spawn showing each agent's live progress. No more waiting in the dark.

#### Quick Setup

1. **Enable tmux integration** in `oh-my-opencode-slim.json` (see [Plugin Config](#plugin-config-oh-my-opencode-slimjson)).

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

   Or use a custom port (must match `OPENCODE_PORT` env var):
    ```bash
    tmux
    export OPENCODE_PORT=5000
    opencode --port 5000
    ```

   This allows multiple OpenCode instances on different ports.


#### Layout Options

| Layout | Description |
|--------|-------------|
| `main-vertical` | Your session on the left (60%), agents stacked on the right |
| `main-horizontal` | Your session on top (60%), agents stacked below |
| `tiled` | All panes in equal-sized grid |
| `even-horizontal` | All panes side by side |
| `even-vertical` | All panes stacked vertically |

---

### Quota Tool

For Antigravity users. You can trigger this at any time by asking the agent to **"check my quota"** or **"show status."**

<img src="img/quota.png" alt="Antigravity Quota" width="600">

| Tool | Description |
|------|-------------|
| `antigravity_quota` | Check API quota for all Antigravity accounts (compact view with progress bars) |

---

### Background Tasks

The plugin provides tools to manage asynchronous work:

| Tool | Description |
|------|-------------|
| `background_task` | Launch an agent in a new session (`sync=true` blocks, `sync=false` runs in background) |
| `background_output` | Fetch the result of a background task by ID |
| `background_cancel` | Abort running tasks |

---

### LSP Tools

Language Server Protocol integration for code intelligence:

| Tool | Description |
|------|-------------|
| `lsp_goto_definition` | Jump to symbol definition |
| `lsp_find_references` | Find all usages of a symbol across the workspace |
| `lsp_diagnostics` | Get errors/warnings from the language server |
| `lsp_rename` | Rename a symbol across all files |

> **Built-in LSP Servers:** OpenCode includes pre-configured LSP servers for 30+ languages (TypeScript, Python, Rust, Go, etc.). See the [official documentation](https://opencode.ai/docs/lsp/#built-in) for the full list and requirements.

---

### Code Search Tools

Fast code search and refactoring:

| Tool | Description |
|------|-------------|
| `grep` | Fast content search using ripgrep |
| `ast_grep_search` | AST-aware code pattern matching (25 languages) |
| `ast_grep_replace` | AST-aware code refactoring with dry-run support |

---

### Formatters

OpenCode automatically formats files after they're written or edited using language-specific formatters.

> **Built-in Formatters:** Includes support for Prettier, Biome, gofmt, rustfmt, ruff, and 20+ others. See the [official documentation](https://opencode.ai/docs/formatters/#built-in) for the complete list.

---

## 🧩 Skills

Skills are specialized capabilities that agents can use. Each agent has a default set of skills, which you can override in the agent config.

### Available Skills

| Skill | Description |
|-------|-------------|
| `yagni-enforcement` | Code complexity analysis and YAGNI enforcement |
| `playwright` | Browser automation via Playwright MCP |

### Default Skill Assignments

| Agent | Default Skills |
|-------|----------------|
| `orchestrator` | `*` (all skills) |
| `designer` | `playwright` |
| `oracle` | none |
| `librarian` | none |
| `explorer` | none |
| `fixer` | none |

### YAGNI Enforcement

**The Minimalist's sacred truth: every line of code is a liability.**

Use after major refactors or before finalizing PRs. Identifies unnecessary complexity, challenges premature abstractions, estimates LOC reduction, and enforces minimalism.

### Playwright Integration

**Browser automation for visual verification and testing.**

- **Browser Automation**: Full Playwright capabilities (browsing, clicking, typing, scraping).
- **Screenshots**: Capture visual state of any web page.
- **Sandboxed Output**: Screenshots saved to session subdirectory (check tool output for path).

### Customizing Agent Skills

Override skills per-agent in your [Plugin Config](#plugin-config-oh-my-opencode-slimjson):

```json
{
  "agents": {
    "orchestrator": {
      "skills": ["*"]
    },
    "designer": {
      "skills": ["playwright"]
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

### Disabling MCPs

You can disable specific MCP servers by adding them to the `disabled_mcps` array in your [Plugin Config](#plugin-config-oh-my-opencode-slimjson).

---

## Configuration

### Files You Edit

| File | Purpose |
|------|---------|
| `~/.config/opencode/opencode.json` | OpenCode core settings |
| `~/.config/opencode/oh-my-opencode-slim.json` | Plugin settings (agents, tmux, MCPs) |
| `.opencode/oh-my-opencode-slim.json` | Project-local plugin overrides (optional) |

---

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

---

### Plugin Config (`oh-my-opencode-slim.json`)

The installer generates this file based on your providers. You can manually customize it to mix and match models.

### Presets

The installer generates presets for different provider combinations. Switch between them by changing the `preset` field.

<details open>
<summary><b>Example: Antigravity + OpenAI (Recommended)</b></summary>

```json
{
  "preset": "antigravity-openai",
  "presets": {
    "antigravity": {
      "orchestrator": { "model": "google/claude-opus-4-5-thinking", "skills": ["*"] },
      "oracle": { "model": "google/claude-opus-4-5-thinking", "variant": "high", "skills": [] },
      "librarian": { "model": "google/gemini-3-flash", "variant": "low", "skills": [] },
      "explorer": { "model": "google/gemini-3-flash", "variant": "low", "skills": [] },
      "designer": { "model": "google/gemini-3-flash", "variant": "medium", "skills": ["playwright"] },
      "fixer": { "model": "google/gemini-3-flash", "variant": "low", "skills": [] }
    },
    "openai": {
      "orchestrator": { "model": "openai/gpt-5.2-codex", "skills": ["*"] },
      "oracle": { "model": "openai/gpt-5.2-codex", "variant": "high", "skills": [] },
      "librarian": { "model": "openai/gpt-5.1-codex-mini", "variant": "low", "skills": [] },
      "explorer": { "model": "openai/gpt-5.1-codex-mini", "variant": "low", "skills": [] },
      "designer": { "model": "openai/gpt-5.1-codex-mini", "variant": "medium", "skills": ["playwright"] },
      "fixer": { "model": "openai/gpt-5.1-codex-mini", "variant": "low", "skills": [] }
    },
    "zen-free": {
      "orchestrator": { "model": "opencode/glm-4.7-free", "skills": ["*"] },
      "oracle": { "model": "opencode/glm-4.7-free", "variant": "high", "skills": [] },
      "librarian": { "model": "opencode/grok-code", "variant": "low", "skills": [] },
      "explorer": { "model": "opencode/grok-code", "variant": "low", "skills": [] },
      "designer": { "model": "opencode/grok-code", "variant": "medium", "skills": ["playwright"] },
      "fixer": { "model": "opencode/grok-code", "variant": "low", "skills": [] }
    },
    "antigravity-openai": {
      "orchestrator": { "model": "google/claude-opus-4-5-thinking", "skills": ["*"] },
      "oracle": { "model": "openai/gpt-5.2-codex", "variant": "high", "skills": [] },
      "librarian": { "model": "google/gemini-3-flash", "variant": "low", "skills": [] },
      "explorer": { "model": "google/gemini-3-flash", "variant": "low", "skills": [] },
      "designer": { "model": "google/gemini-3-flash", "variant": "medium", "skills": ["playwright"] },
      "fixer": { "model": "google/gemini-3-flash", "variant": "low", "skills": [] }
    }
  },
  "tmux": {
    "enabled": true,
    "layout": "main-vertical",
    "main_pane_size": 60
  }
}
```
</details>

**Available Presets:**

| Preset | Description |
|--------|-------------|
| `antigravity` | Google models (Claude Opus + Gemini Flash) |
| `openai` | OpenAI models (GPT-5.2 + GPT-5.1-mini) |
| `zen-free` | Free models (GLM-4.7 + Grok Code) |
| `antigravity-openai` | Mixed: Antigravity for most agents, OpenAI for Oracle |

#### Author's Preset

The author's personal configuration using Cerebras for the Orchestrator:

```json
{
  "cerebras": {
    "orchestrator": { "model": "cerebras/zai-glm-4.7", "skills": ["*"] },
    "oracle": { "model": "openai/gpt-5.2-codex", "variant": "high", "skills": [] },
    "librarian": { "model": "google/gemini-3-flash", "variant": "low", "skills": [] },
    "explorer": { "model": "google/gemini-3-flash", "variant": "low", "skills": [] },
    "designer": { "model": "google/gemini-3-flash", "variant": "medium", "skills": ["playwright"] },
    "fixer": { "model": "google/gemini-3-flash", "variant": "low", "skills": [] }
  }
}
```

**Environment Variable Override:**

You can override the preset using an environment variable:

```bash
export OH_MY_OPENCODE_SLIM_PRESET=openai
opencode
```

The environment variable takes precedence over the `preset` field in the config file.

#### Option Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `preset` | string | - | Name of the preset to use (e.g., `"antigravity"`, `"openai"`) |
| `presets` | object | - | Named preset configurations containing agent mappings |
| `presets.<name>.<agent>.model` | string | - | Model ID for the agent (e.g., `"google/claude-opus-4-5-thinking"`) |
| `presets.<name>.<agent>.temperature` | number | - | Temperature setting (0-2) for the agent |
| `presets.<name>.<agent>.variant` | string | - | Agent variant for reasoning effort (e.g., `"low"`, `"medium"`, `"high"`) |
| `presets.<name>.<agent>.skills` | string[] | - | Array of skill names the agent can use (`"*"` for all) |
| `tmux.enabled` | boolean | `false` | Enable tmux pane spawning for sub-agents |
| `tmux.layout` | string | `"main-vertical"` | Layout preset: `main-vertical`, `main-horizontal`, `tiled`, `even-horizontal`, `even-vertical` |
| `tmux.main_pane_size` | number | `60` | Main pane size as percentage (20-80) |
| `disabled_mcps` | string[] | `[]` | MCP server IDs to disable (e.g., `"websearch"`) |

> **Note:** Agent configuration should be defined within `presets`. The root-level `agents` field is deprecated.

---

## Uninstallation

1. **Remove the plugin from your OpenCode config**:

   Edit `~/.config/opencode/opencode.json` and remove `"oh-my-opencode-slim"` from the `plugin` array.

2. **Remove configuration files (optional)**:
   ```bash
   rm -f ~/.config/opencode/oh-my-opencode-slim.json
   rm -f .opencode/oh-my-opencode-slim.json
   ```

---

## Credits

This is a slimmed-down fork of [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) by [@code-yeongyu](https://github.com/code-yeongyu).

---

## License

MIT
