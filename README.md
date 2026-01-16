<div align="center">

# oh-my-opencode-slim

**A lightweight, powerful agent orchestration plugin for OpenCode**

<img src="img/team.png" alt="The Pantheon - Agent Team" width="600">

*Transform your AI assistant into a manager capable of delegating complex tasks to specialized sub-agents, running searches in the background, and managing multi-step workflows with ease.*

</div>

> Slimmed-down fork of [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) - focused on core agent orchestration without the extra bells and whistles.

> **[Antigravity](https://antigravity.ai) subscription recommended.** The pantheon is tuned for Antigravity's model routing. Other providers work, but you'll get the best experience with Antigravity.

---

## ⚡ Quick Navigation

- [🚀 **Installation**](#installation)
  - [For Humans](#for-humans)
  - [For LLM Agents](#for-llm-agents)
- [🏗️ **Architecture & Flow**](#architecture--flow)
- [🏛️ **Meet the Pantheon**](#meet-the-pantheon)
  - [The Orchestrator](#the-orchestrator---architect-of-realms)
  - [The Explorer](#the-explorer---pathfinder)
  - [The Oracle](#the-oracle---seer-beyond-the-stack-trace)
  - [The Librarian](#the-librarian---keeper-of-infinite-scrolls)
  - [The Designer](#the-designer---artisan-of-interfaces)
  - [The Scribe](#the-scribe---chronicle-keeper)
  - [The Visionary](#the-visionary---reader-of-pixels)
  - [The Minimalist](#the-minimalist---destroyer-of-bloat)
- [🛠️ **Tools & Capabilities**](#tools--capabilities)
  - [Tmux Integration](#tmux-integration)
  - [Quota Tool](#quota-tool)
  - [Background Tasks](#background-tasks)
  - [LSP Tools](#lsp-tools)
  - [Code Search Tools](#code-search-tools)
- [🔌 **MCP Servers**](#mcp-servers)
- [⚙️ **Configuration**](#configuration)
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
bunx oh-my-opencode-slim install --no-tui --antigravity=yes --openai=yes --cerebras=no
```

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
3. "Do you have access to **Cerebras** API?" *(Enables `cerebras/` for fast exploration)*

---

#### Step 3: Run the Installer

Based on answers, run:

```bash
bunx oh-my-opencode-slim install --no-tui --antigravity=<yes|no> --openai=<yes|no> --cerebras=<yes|no>
```

**Examples:**
```bash
# Antigravity + OpenAI
bunx oh-my-opencode-slim install --no-tui --antigravity=yes --openai=yes --cerebras=no

# OpenAI only
bunx oh-my-opencode-slim install --no-tui --antigravity=no --openai=yes --cerebras=no

# All providers
bunx oh-my-opencode-slim install --no-tui --antigravity=yes --openai=yes --cerebras=yes
```

The installer automatically:
- Adds the plugin to `~/.config/opencode/opencode.json`
- Adds `opencode-antigravity-auth` plugin (if Antigravity enabled)
- Configures Google provider with model definitions
- Generates agent model mappings in `~/.config/opencode/oh-my-opencode-slim.json`

---

#### Step 4: Authentication

After installation, guide the user to log in for each enabled provider:

```bash
opencode auth login
```

The user should select:
- **For Antigravity**: Google → OAuth with Google (Antigravity)
- **For OpenAI**: OpenAI → Enter API Key
- **For Cerebras**: Cerebras → Enter API Key

---

#### Step 5: Verify

```bash
opencode
```

---

#### Troubleshooting

If the installer fails, check the expected config format:
```bash
bunx oh-my-opencode-slim install --help
```

Then manually create the config files at:
- `~/.config/opencode/opencode.json`
- `~/.config/opencode/oh-my-opencode-slim.json`

</details>

---

## Architecture & Flow

The plugin follows a "Hub and Spoke" model:

1. **The Orchestrator (Hub)**: The main entry point for user requests. It analyzes the task and decides which specialized agents to call.
2. **Specialized Agents (Spokes)**: Domain-specific experts (e.g., UI/UX, Documentation, Architecture) that handle narrow tasks with high precision.
3. **Background Manager**: A robust engine that allows the Orchestrator to "fire and forget" tasks (like deep codebase searches or documentation research) while continuing to work on other parts of the problem.

### The Flow of a Request

<img src="img/intro.png" alt="Orchestration Flow" width="800">

1. **User Prompt**: "Refactor the auth logic and update the docs."
2. **Orchestrator**: Creates a TODO list.
3. **Delegation**:
   - Launches an `@explore` background task to find all auth-related files.
   - Launches a `@librarian` task to check the latest documentation for the auth library used.
4. **Integration**: Once background results are ready, the Orchestrator performs the refactor.
5. **Finalization**: Passes the changes to `@document-writer` to update the README.

---

## Meet the Pantheon

<br clear="both">

### The Orchestrator - *Architect of Realms*

<a href="src/agents/orchestrator.ts"><img src="img/orchestrator.png" alt="The Orchestrator" align="right" width="240"></a>

> **The Orchestrator** was born when the first codebase collapsed under its own complexity. Neither god nor mortal would claim responsibility-so The Orchestrator emerged from the void, forging order from chaos. They don't merely command armies; they fight alongside them. Every line of code passes through their hands before they decide which lesser deity deserves a piece of the puzzle.

**Role:** Supreme executor, delegator, and overseer - **Model:** `google/claude-opus-4-5-thinking`

Write and execute code, orchestrate multi-agent workflows, parse the unspoken from the spoken, summon specialists mid-battle. Shape reality directly-and assign realms to others when the universe grows too vast.

<br clear="both">

---

### The Explorer - *Pathfinder*

<a href="src/agents/explore.ts"><img src="img/explorer.png" alt="The Explorer" align="right" width="240"></a>

> **The Explorer** moves through codebases like wind through trees-swift, silent, everywhere at once. When The Orchestrator whispers "find me the auth module," The Explorer has already returned with forty file paths and a map. They were born from the first `grep` command, evolved beyond it, and now see patterns mortals miss.

**Role:** Codebase reconnaissance - **Model:** `cerebras/zai-glm-4.6`

Regex search, AST pattern matching, file discovery, parallel exploration. Read-only: they chart the territory; others conquer it.

<br clear="both">

---

### The Oracle - *Seer Beyond the Stack Trace*

<a href="src/agents/oracle.ts"><img src="img/oracle.png" alt="The Oracle" align="right" width="240"></a>

> **The Oracle** does not code-they *know*. When bugs defy logic and architectures crumble, The Oracle gazes into the abyss of your codebase and speaks truth. They've seen a thousand systems rise and fall. They'll tell you which path leads to ruin, and which to production.

**Role:** Strategic advisor and debugger of last resort - **Model:** `openai/gpt-5.2-codex`

Root cause analysis, architecture review, debugging guidance, tradeoff analysis. Read-only: Oracles advise; they don't intervene.

<br clear="both">

---

### The Librarian - *Keeper of Infinite Scrolls*

<a href="src/agents/librarian.ts"><img src="img/librarian.png" alt="The Librarian" align="right" width="240"></a>

> **The Librarian** guards a library with no walls-every GitHub repo, every npm package, every StackOverflow answer ever written. Ask them "how does React handle concurrent rendering?" and they'll return with official docs, real-world examples, and a warning about the footgun you're about to step on.

**Role:** External knowledge retrieval - **Model:** `google/gemini-3-flash`

Documentation lookup, GitHub code search, library research, best practice retrieval. Read-only: they fetch wisdom; implementation is for others.

<br clear="both">

---

### The Designer - *Artisan of Interfaces*

<a href="src/agents/frontend.ts"><img src="img/designer.png" alt="The Designer" align="right" width="240"></a>

> **The Designer** believes code should be beautiful-and so should everything it renders. Born from the frustration of a thousand ugly MVPs, they wield CSS like a brush and components like clay. Hand them a feature request; receive a masterpiece. They don't do "good enough."

**Role:** UI/UX implementation and visual excellence - **Model:** `google/gemini-3-flash`

Modern responsive design, CSS/Tailwind mastery, micro-animations, component architecture. Visual excellence over code perfection-beauty is the priority.

<br clear="both">

---

### The Scribe - *Chronicle Keeper*

<a href="src/agents/document-writer.ts"><img src="img/scribe.png" alt="The Scribe" align="right" width="240"></a>

> **The Scribe** was there when the first README was written-and wept, for it was incomplete. They have devoted eternity to the sacred art of documentation: clear, scannable, honest. While others ship features, The Scribe ensures those features are understood. Every code example works. Every explanation enlightens.

**Role:** Technical documentation and knowledge capture - **Model:** `google/gemini-3-flash`

README crafting, API documentation, architecture docs, inline comments that don't insult your intelligence. Match existing style; focus on "why," not just "what."

<br clear="both">

---

### The Visionary - *Reader of Pixels*

<a href="src/agents/multimodal.ts"><img src="img/multimodal.png" alt="The Visionary" align="right" width="240"></a>

> **The Visionary** sees what others cannot-literally. Screenshots, wireframes, diagrams, PDFs: all are text to them. When a designer throws a Figma mockup at the team and vanishes, The Visionary translates vision into specification. They read the unreadable and describe the indescribable.

**Role:** Image and visual content analysis - **Model:** `google/gemini-3-flash`

Extract text from images, interpret diagrams, analyze UI screenshots, summarize visual documents. Report what they observe; inference is for others.

<br clear="both">

---

### The Minimalist - *Destroyer of Bloat*

<a href="src/agents/simplicity-reviewer.ts"><img src="img/code-simplicity.png" alt="The Minimalist" align="right" width="240"></a>

> **The Minimalist** has one sacred truth: every line of code is a liability. They hunt abstractions that serve no purpose, defensive checks that defend nothing, and "clever" solutions that will haunt you in six months. Where others add, The Minimalist subtracts-ruthlessly, joyfully, necessarily.

**Role:** Code simplification and YAGNI enforcement - **Model:** `google/claude-opus-4-5-thinking`

Identify unnecessary complexity, challenge premature abstractions, estimate LOC reduction, enforce minimalism. Read-only: they judge; The Orchestrator executes the sentence.

<br clear="both">

---

## Tools & Capabilities

### Tmux Integration

<img src="img/tmux.png" alt="Tmux Integration" width="800">

**Watch your agents work in real-time.** When the Orchestrator launches sub-agents or initiates background tasks, new tmux panes automatically spawn showing each agent's live progress. No more waiting in the dark.

#### Why This Matters

| Without Tmux Integration | With Tmux Integration |
|--------------------------|----------------------|
| Fire off a background task, wait anxiously | See the agent thinking, searching, coding |
| "Is it stuck or just slow?" | Watch tool calls happen in real-time |
| Results appear out of nowhere | Follow the journey from question to answer |
| Debug by guessing | Debug by observation |

#### What You Get

- **Live Visibility**: Each sub-agent gets its own pane showing real-time output
- **Auto-Layout**: Tmux automatically arranges panes using your preferred layout
- **Auto-Cleanup**: Panes close when agents finish, layout rebalances
- **Zero Overhead**: Works with OpenCode's built-in `task` tool AND our `background_task` tool

#### Quick Setup

**1. Enable the OpenCode HTTP server** (one-time setup)

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "server": {
    "port": 4096
  }
}
```

**2. Enable tmux integration in the plugin**

Add to your `~/.config/opencode/oh-my-opencode-slim.json`:

```json
{
  "tmux": {
    "enabled": true,
    "layout": "main-vertical",
    "main_pane_size": 60
  }
}
```

**3. Run OpenCode inside tmux**

```bash
tmux
opencode
```

That's it. When agents spawn, they'll appear in new panes.

#### Layout Options

| Layout | Description |
|--------|-------------|
| `main-vertical` | Your session on the left (60%), agents stacked on the right |
| `main-horizontal` | Your session on top (60%), agents stacked below |
| `tiled` | All panes in equal-sized grid |
| `even-horizontal` | All panes side by side |
| `even-vertical` | All panes stacked vertically |

#### Configuration Reference

```json
{
  "tmux": {
    "enabled": true,
    "layout": "main-vertical",
    "main_pane_size": 60
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable/disable tmux integration |
| `layout` | string | `"main-vertical"` | Tmux layout preset |
| `main_pane_size` | number | `60` | Size of main pane as percentage (20-80) |

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

---

### Code Search Tools

Fast code search and refactoring:

| Tool | Description |
|------|-------------|
| `grep` | Fast content search using ripgrep |
| `ast_grep_search` | AST-aware code pattern matching (25 languages) |
| `ast_grep_replace` | AST-aware code refactoring with dry-run support |

---

## MCP Servers

Built-in Model Context Protocol servers (enabled by default):

| MCP | Purpose | URL |
|-----|---------|-----|
| `websearch` | Real-time web search via Exa AI | `https://mcp.exa.ai/mcp` |
| `context7` | Official library documentation | `https://mcp.context7.com/mcp` |
| `grep_app` | GitHub code search via grep.app | `https://mcp.grep.app` |

### Disabling MCPs

You can disable specific MCP servers in your config:

```json
{
  "disabled_mcps": ["websearch", "grep_app"]
}
```

---

## Configuration

You can customize the behavior of the plugin via JSON configuration files.

### Configuration Files

The plugin looks for configuration in two places (and merges them):

1. **User Global**: `~/.config/opencode/oh-my-opencode-slim.json` (or OS equivalent)
2. **Project Local**: `./.opencode/oh-my-opencode-slim.json`

| Platform | User Config Path |
| :--- | :--- |
| **Windows** | `~/.config/opencode/oh-my-opencode-slim.json` or `%APPDATA%\opencode\oh-my-opencode-slim.json` |
| **macOS/Linux** | `~/.config/opencode/oh-my-opencode-slim.json` |

### Disabling Agents

You can disable specific agents using the `disabled_agents` array:

```json
{
  "disabled_agents": ["multimodal-looker", "code-simplicity-reviewer"]
}
```

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
