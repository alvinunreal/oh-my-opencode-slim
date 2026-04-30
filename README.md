<div align="center">
  <img src="img/team.jpeg" alt="Pantheon agents" style="border-radius: 10px;">
  <p><i>Seven divine beings emerged from the dawn of code, each an immortal master of their craft await your command to forge order from chaos and build what was once thought impossible.</i></p>
  <p><b>Open Multi Agent Suite</b> · Mix any models · Auto delegate tasks</p>

  <p><sub>by <b>Boring Dystopia Development</b></sub></p>
  <p>
    <a href="https://boringdystopia.ai/"><img src="https://img.shields.io/badge/boringdystopia.ai-111111?style=for-the-badge&logo=vercel&logoColor=white" alt="boringdystopia.ai"></a>&nbsp;
    <a href="https://x.com/alvinunreal"><img src="https://img.shields.io/badge/X-@alvinunreal-000000?style=for-the-badge&logo=x&logoColor=white" alt="X @alvinunreal"></a>&nbsp;
    <a href="https://t.me/boringdystopiadevelopment"><img src="https://img.shields.io/badge/Telegram-Join%20channel-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram Join channel"></a>&nbsp;
  </p>
</div>

---

## What's This Plugin

oh-my-opencode-slim is an agent orchestration plugin for OpenCode. It includes a built-in team of specialized agents that can scout a codebase, look up fresh documentation, review architecture, handle UI work, and execute well-scoped implementation tasks under one orchestrator.

The main idea is simple: instead of forcing one model to do everything, the plugin routes each part of the job to the agent best suited for it, balancing **quality, speed and cost**.

To explore the agents themselves, see **[Meet the Pantheon](#meet-the-pantheon)**. For the full feature set, see **[Features & Workflows](#features-and-workflows)** below.

### Quick Start

Copy and paste this prompt to your LLM agent (Claude Code, AmpCode, Cursor, etc.):


```
Install and configure oh-my-opencode-slim: https://raw.githubusercontent.com/alvinunreal/oh-my-opencode-slim/refs/heads/master/README.md
```


### Manual Installation

```bash
bunx oh-my-opencode-slim@latest install
```

The installer also registers the companion TUI plugin in OpenCode's
`tui.json`, which adds a small sidebar showing specialist-agent status plus
active/reusable task sessions. For manual setups, add `oh-my-opencode-slim` to
the `plugin` array in both `opencode.json` and `tui.json`.

### Getting Started

The installer generates both OpenAI and OpenCode Go presets, with OpenAI active by default. OpenAI uses `openai/gpt-5.5` for the higher-judgment agents and `openai/gpt-5.4-mini` for the faster scoped agents. To make OpenCode Go active during install, run `bunx oh-my-opencode-slim@latest install --preset=opencode-go`.

Then:

1. **Log in to the providers you want to use if you haven't already**:

   ```bash
   opencode auth login
   ```
2. **Refresh and list the models OpenCode can see**:

   ```bash
   opencode models --refresh
   ```
3. **Open your plugin config** at `~/.config/opencode/oh-my-opencode-slim.json`

4. **Update the models you want for each agent**

> [!TIP]
> Want to understand how automatic delegation works in practice? Review the **[Orchestrator prompt](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/src/agents/orchestrator.ts#L28)** — it contains the delegation rules, specialist routing logic, and the thresholds for when the main agent should hand work off to subagents.

The default generated configuration includes both `openai` and `opencode-go` presets. Abbreviated:

```jsonc
{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json",
  "preset": "openai",
  "presets": {
    "openai": {
      "orchestrator": { "model": "openai/gpt-5.5", "skills": ["*"], "mcps": ["*", "!context7"] },
      "oracle": { "model": "openai/gpt-5.5", "variant": "high", "skills": ["simplify"], "mcps": [] },
      "librarian": { "model": "openai/gpt-5.4-mini", "variant": "low", "skills": [], "mcps": ["websearch", "context7", "grep_app"] },
      "explorer": { "model": "openai/gpt-5.4-mini", "variant": "low", "skills": [], "mcps": [] },
      "designer": { "model": "openai/gpt-5.4-mini", "variant": "medium", "skills": ["agent-browser"], "mcps": [] },
      "fixer": { "model": "openai/gpt-5.4-mini", "variant": "low", "skills": [], "mcps": [] }
    }
  }
}
```

Session management is enabled by default even though it is not shown in the
starter config. See **[Session Management](docs/session-management.md)** if you
want to customize how many resumable child-agent sessions are remembered.

### For Alternative Providers

To use OpenCode Go, Kimi, GitHub Copilot, ZAI Coding Plan, or a mixed-provider setup, use **[Configuration](docs/configuration.md)** for the full reference. If you want a ready-made starting point, check the **[Author's Preset](docs/authors-preset.md)** and **[$30 Preset](docs/thirty-dollars-preset.md)** - the `$30` preset is the best cheap setup.

The configuration guide also covers custom subagents via `agents.<name>`, where
you can define both a normal `prompt` and an `orchestratorPrompt` block for
delegation.

You can also mix and match any models per agent. For model suggestions, see the **Recommended Models** listed under each agent below.

### ✅ Verify Your Setup

After installation and authentication, verify all agents are configured and responding:

```bash
opencode
```

Then run:

```
ping all agents
```

<div align="center">
  <img src="img/ping.png" alt="Ping all agents" width="600">
  <p><i>Confirmation that all configured agents are online and ready.</i></p>
</div>

If any agent fails to respond, check your provider authentication and config file.

---

<a id="meet-the-pantheon"></a>

## 🏛️ Meet the Pantheon

### 01. Orchestrator: The Embodiment Of Order

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/orchestrator.png" width="240" style="border-radius: 10px;">
      <br><sub><i>Forged in the void of complexity.</i></sub>
    </td>
    <td width="70%" valign="top">
      The Orchestrator was born when the first codebase collapsed under its own complexity. Neither god nor mortal would claim responsibility - so The Orchestrator emerged from the void, forging order from chaos. It determines the optimal path to any goal, balancing speed, quality, and cost. It guides the team, summoning the right specialist for each task and delegating to achieve the best possible outcome.
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Role:</b> <code>Master delegator and strategic coordinator</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/orchestrator.ts"><code>orchestrator.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Model:</b> <code>openai/gpt-5.5</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>openai/gpt-5.5</code> <code>anthropic/claude-opus-4.6</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> Choose your default, strongest all-around coding model. Orchestrator is both the main coding agent and the delegator, so it needs strong implementation ability, good judgment, and reliable instruction-following.
    </td>
  </tr>
</table>

---

### 02. Explorer: The Eternal Wanderer

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/explorer.png" width="240" style="border-radius: 10px;">
      <br><sub><i>The wind that carries knowledge.</i></sub>
    </td>
    <td width="70%" valign="top">
      The Explorer is an immortal wanderer who has traversed the corridors of a million codebases since the dawn of programming. Cursed with the gift of eternal curiosity, they cannot rest until every file is known, every pattern understood, every secret revealed. Legends say they once searched the entire internet in a single heartbeat. They are the wind that carries knowledge, the eyes that see all, the spirit that never sleeps.
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Role:</b> <code>Codebase reconnaissance</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/explorer.ts"><code>explorer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Model:</b> <code>openai/gpt-5.4-mini</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>cerebras/zai-glm-4.7</code> <code>fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo</code> <code>openai/gpt-5.4-mini</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> Choose a fast, low-cost model. Explorer handles broad scouting work, so speed and efficiency usually matter more than using your strongest reasoning model.
    </td>
  </tr>
</table>

---

### 03. Oracle: The Guardian of Paths

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/oracle.png" width="240" style="border-radius: 10px;">
      <br><sub><i>The voice at the crossroads.</i></sub>
    </td>
    <td width="70%" valign="top">
      The Oracle stands at the crossroads of every architectural decision. They have walked every road, seen every destination, know every trap that lies ahead. When you stand at the precipice of a major refactor, they are the voice that whispers which way leads to ruin and which way leads to glory. They don't choose for you - they illuminate the path so you can choose wisely.
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Role:</b> <code>Strategic advisor and debugger of last resort</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/oracle.ts"><code>oracle.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Model:</b> <code>openai/gpt-5.5 (high)</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>openai/gpt-5.5 (high)</code> <code>google/gemini-3.1-pro-preview (high)</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> Choose your strongest high-reasoning model for architecture, hard debugging, trade-offs, and code review.
    </td>
  </tr>
</table>

---

### 04. Council: The Chorus of Minds

> [!NOTE]
> **Why doesn't Orchestrator auto-call Council more often?** This is intentional. Council runs multiple models at once, so automatic delegation is kept strict because it is usually the highest-cost path in the system. In practice, Council is meant to be used manually when you want it, for example: <code>@council compare these two architectures</code>.

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/council.png" width="240" style="border-radius: 10px;">
      <br><sub><i>Many minds, one verdict.</i></sub>
    </td>
    <td width="70%" valign="top">
      The Council is not a lone being but a chamber of minds summoned when one answer is not enough. It sends your question to multiple models in parallel, gathers their competing judgments, and then the Council agent itself distills the strongest ideas into a single verdict. Where a solitary agent may miss a path, the Council cross-examines possibility itself.
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Role:</b> <code>Multi-LLM consensus and synthesis</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/council.ts"><code>council.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Guide:</b> <a href="docs/council.md"><code>docs/council.md</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Setup:</b> <code>Config-driven</code> — councillors come from <code>council.presets</code> and the Council agent model comes from your normal <code>council</code> agent config
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Setup:</b> <code>Strong Council model</code> + <code>diverse councillors</code> across providers
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> Use a strong synthesis model for the Council agent and diverse models as councillors. The value of Council comes from comparing different model perspectives, not just picking the single strongest model everywhere.
    </td>
  </tr>
</table>

---

### 05. Librarian: The Weaver of Knowledge

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/librarian.png" width="240" style="border-radius: 10px;">
      <br><sub><i>The weaver of understanding.</i></sub>
    </td>
    <td width="70%" valign="top">
      The Librarian was forged when humanity realized that no single mind could hold all knowledge. They are the weaver who connects disparate threads of information into a tapestry of understanding. They traverse the infinite library of human knowledge, gathering insights from every corner and binding them into answers that transcend mere facts. What they return is not information - it's understanding.
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Role:</b> <code>External knowledge retrieval</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/librarian.ts"><code>librarian.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Model:</b> <code>openai/gpt-5.4-mini</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>cerebras/zai-glm-4.7</code> <code>fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo</code> <code>openai/gpt-5.4-mini</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> Choose a fast, low-cost model. Librarian handles research and documentation lookups, so speed and efficiency usually matter more than using your strongest reasoning model.
    </td>
  </tr>
</table>

---

### 06. Designer: The Guardian of Aesthetics

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/designer.png" width="240" style="border-radius: 10px;">
      <br><sub><i>Beauty is essential.</i></sub>
    </td>
    <td width="70%" valign="top">
      The Designer is an immortal guardian of beauty in a world that often forgets it matters. They have seen a million interfaces rise and fall, and they remember which ones were remembered and which were forgotten. They carry the sacred duty to ensure that every pixel serves a purpose, every animation tells a story, every interaction delights. Beauty is not optional - it's essential.
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Role:</b> <code>UI/UX implementation and visual excellence</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/designer.ts"><code>designer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Model:</b> <code>openai/gpt-5.4-mini</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>google/gemini-3.1-pro-preview</code> <code>kimi-for-coding/k2p5</code> 
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> Choose a model that is strong at UI/UX judgment, frontend implementation, and visual polish.
    </td>
  </tr>
</table>

---

### 07. Fixer: The Last Builder

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/fixer.png" width="240" style="border-radius: 10px;">
      <br><sub><i>The final step between vision and reality.</i></sub>
    </td>
    <td width="70%" valign="top">
      The Fixer is the last of a lineage of builders who once constructed the foundations of the digital world. When the age of planning and debating began, they remained - the ones who actually build. They carry the ancient knowledge of how to turn thought into thing, how to transform specification into implementation. They are the final step between vision and reality.
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Role:</b> <code>Fast implementation specialist</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/fixer.ts"><code>fixer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Model:</b> <code>openai/gpt-5.4-mini</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>cerebras/zai-glm-4.7</code> <code>fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo</code> <code>openai/gpt-5.4-mini</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> Choose a fast, reliable coding model for routine, scoped implementation work. Fixer usually receives a concrete plan or bounded instructions from Orchestrator, making it a good place for efficient execution tasks such as tests, test updates, and straightforward code changes.
    </td>
  </tr>
</table>

---

## Optional Agents

### Observer: The Silent Witness

> [!NOTE]
> **Why a separate agent?** If your Orchestrator model is not multimodal, enable Observer to handle images, screenshots, PDFs, and other visual files. Observer is disabled by default and gives the Orchestrator a dedicated multimodal reader without forcing you to change your main reasoning model. Set `disabled_agents: []` and an `observer` model in your configuration.

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/observer.jpg" width="240" style="border-radius: 10px;">
      <br><sub><i>The eye that reads what others cannot.</i></sub>
    </td>
    <td width="70%" valign="top">

**Read-only visual analysis** — interprets images, screenshots, PDFs, and diagrams. Returns structured observations to the orchestrator without loading raw file bytes into the main context window.

- Images, screenshots, diagrams → `read` tool (native image support)
- PDFs and binary documents → `read` tool (text + structure extraction)
- **Disabled by default** — enable with `"disabled_agents": []` and configure a vision-capable model

    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/observer.ts"><code>observer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Model:</b> <code>openai/gpt-5.4-mini</code> — <i>configure a vision-capable model to enable</i>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> Choose a vision-capable model if you want the agent to read screenshots, images, PDFs, and other visual files.
    </td>
  </tr>
</table>

---

## 📚 Documentation

Use this section as a map: start with installation, then jump to features, configuration, or example presets depending on what you need.

### 🚀 Start Here

| Doc | What it covers |
|-----|----------------|
| **[Installation Guide](docs/installation.md)** | Install the plugin, use CLI flags, reset config, and troubleshoot setup |

<a id="features-and-workflows"></a>

### ✨ Features & Workflows

| Doc | What it covers |
|-----|----------------|
| **[Council](docs/council.md)** | Run multiple models in parallel and synthesize a single answer with `@council` |
| **[Interview](docs/interview.md)** | Turn rough ideas into a structured markdown spec through a browser-based Q&A flow |
| **[Multiplexer Integration](docs/multiplexer-integration.md)** | Watch agents work live in Tmux or Zellij panes |
| **[Session Management](docs/session-management.md)** | Reuse recent child-agent sessions with short aliases instead of starting over |
| **[Todo Continuation](docs/todo-continuation.md)** | Auto-continue orchestrator sessions with cooldowns and safety checks |
| **[Preset Switching](docs/preset-switching.md)** | Switch agent model presets at runtime with `/preset` |
| **[Codemap](docs/codemap.md)** | Generate hierarchical codemaps to understand large codebases faster |

### ⚙️ Config & Reference

| Doc | What it covers |
|-----|----------------|
| **[Configuration](docs/configuration.md)** | Config file locations, JSONC support, prompt overrides, and full option reference |
| **[Maintainer Guide](docs/maintainers.md)** | Issue triage rules, label meanings, support routing, and repo maintenance workflow |
| **[Skills](docs/skills.md)** | Built-in and recommended skills such as `simplify`, `agent-browser`, and `codemap` |
| **[MCPs](docs/mcps.md)** | `websearch`, `context7`, `grep_app`, and how MCP permissions work per agent |
| **[Tools](docs/tools.md)** | Built-in tool capabilities like `webfetch`, LSP tools, code search, and formatters |

### 💡 Example Presets

| Doc | What it covers |
|-----|----------------|
| **[Author's Preset](docs/authors-preset.md)** | The author's daily mixed-provider setup |
| **[$30 Preset](docs/thirty-dollars-preset.md)** | A budget mixed-provider setup for around $30/month |

---

## 🏛️ Contributors

<div align="center">
  <p><i>The builders, debuggers, writers, and wanderers who have earned their place in the pantheon.</i></p>
  <p><sub>Every merged contribution leaves a mark on the realm.</sub></p>

  <!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-44-orange.svg?style=flat-square)](#contributors-)
<!-- ALL-CONTRIBUTORS-BADGE:END -->
</div>

<br>

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://boringdystopia.ai/"><img src="https://avatars.githubusercontent.com/u/204474669?v=4?s=100" width="100px;" alt="Alvin"/><br /><sub><b>Alvin</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=alvinunreal" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/alvinreal"><img src="https://avatars.githubusercontent.com/u/262747402?v=4?s=100" width="100px;" alt="alvinreal"/><br /><sub><b>alvinreal</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=alvinreal" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/imarshallwidjaja"><img src="https://avatars.githubusercontent.com/u/60992624?v=4?s=100" width="100px;" alt="imw"/><br /><sub><b>imw</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=imarshallwidjaja" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/adikpb"><img src="https://avatars.githubusercontent.com/u/67222969?v=4?s=100" width="100px;" alt="Adithya Kozham Burath Bijoy"/><br /><sub><b>Adithya Kozham Burath Bijoy</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=adikpb" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/ReqX"><img src="https://avatars.githubusercontent.com/u/14987124?v=4?s=100" width="100px;" alt="ReqX"/><br /><sub><b>ReqX</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=ReqX" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/abhideepm"><img src="https://avatars.githubusercontent.com/u/28213051?v=4?s=100" width="100px;" alt="Abhideep Maity"/><br /><sub><b>Abhideep Maity</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=abhideepm" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Daltonganger"><img src="https://avatars.githubusercontent.com/u/17501732?v=4?s=100" width="100px;" alt="Ruben"/><br /><sub><b>Ruben</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Daltonganger" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://horizzon3507.vercel.app/"><img src="https://avatars.githubusercontent.com/u/148660626?v=4?s=100" width="100px;" alt="Gabriel Rodrigues"/><br /><sub><b>Gabriel Rodrigues</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=horizzon3507" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/jmvbambico"><img src="https://avatars.githubusercontent.com/u/45126068?v=4?s=100" width="100px;" alt="John Michael Vincent Bambico"/><br /><sub><b>John Michael Vincent Bambico</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=jmvbambico" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/mfold111"><img src="https://avatars.githubusercontent.com/u/261528848?v=4?s=100" width="100px;" alt="Molt Founders"/><br /><sub><b>Molt Founders</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=mfold111" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://me.mashiro.best/"><img src="https://avatars.githubusercontent.com/u/22992947?v=4?s=100" width="100px;" alt="Muen Yu"/><br /><sub><b>Muen Yu</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=MuenYu" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/NocturnesLK"><img src="https://avatars.githubusercontent.com/u/102891073?v=4?s=100" width="100px;" alt="NocturnesLK"/><br /><sub><b>NocturnesLK</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=NocturnesLK" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="http://riccardosallusti.it/"><img src="https://avatars.githubusercontent.com/u/466102?v=4?s=100" width="100px;" alt="Riccardo Sallusti"/><br /><sub><b>Riccardo Sallusti</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=rizal72" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Yusyuriv"><img src="https://avatars.githubusercontent.com/u/3993179?v=4?s=100" width="100px;" alt="Yan Li"/><br /><sub><b>Yan Li</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Yusyuriv" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/nghyane"><img src="https://avatars.githubusercontent.com/u/59473462?v=4?s=100" width="100px;" alt="Hoàng Văn Anh Nghĩa"/><br /><sub><b>Hoàng Văn Anh Nghĩa</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=nghyane" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Jyers"><img src="https://avatars.githubusercontent.com/u/76993396?v=4?s=100" width="100px;" alt="Jacob Myers"/><br /><sub><b>Jacob Myers</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Jyers" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/kassieclaire"><img src="https://avatars.githubusercontent.com/u/59930829?v=4?s=100" width="100px;" alt="Kassie Povinelli"/><br /><sub><b>Kassie Povinelli</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=kassieclaire" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/KyleHilliard"><img src="https://avatars.githubusercontent.com/u/178682772?v=4?s=100" width="100px;" alt="KyleHilliard"/><br /><sub><b>KyleHilliard</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=KyleHilliard" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/j5hjun"><img src="https://avatars.githubusercontent.com/u/169322508?v=4?s=100" width="100px;" alt="j5hjun"/><br /><sub><b>j5hjun</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=j5hjun" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/marcFernandez"><img src="https://avatars.githubusercontent.com/u/32362792?v=4?s=100" width="100px;" alt="marcFernandez"/><br /><sub><b>marcFernandez</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=marcFernandez" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/mister-test"><img src="https://avatars.githubusercontent.com/u/212316706?v=4?s=100" width="100px;" alt="mister-test"/><br /><sub><b>mister-test</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=mister-test" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/n24q02m"><img src="https://avatars.githubusercontent.com/u/135627235?v=4?s=100" width="100px;" alt="n24q02m"/><br /><sub><b>n24q02m</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=n24q02m" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/oribarilan"><img src="https://avatars.githubusercontent.com/u/8760762?v=4?s=100" width="100px;" alt="oribi"/><br /><sub><b>oribi</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=oribarilan" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/pelidan"><img src="https://avatars.githubusercontent.com/u/45832535?v=4?s=100" width="100px;" alt="pelidan"/><br /><sub><b>pelidan</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=pelidan" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/xLillium"><img src="https://avatars.githubusercontent.com/u/16964936?v=4?s=100" width="100px;" alt="xLillium"/><br /><sub><b>xLillium</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=xLillium" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/CoolZxp"><img src="https://avatars.githubusercontent.com/u/54017765?v=4?s=100" width="100px;" alt="⁢4.435km/s"/><br /><sub><b>⁢4.435km/s</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=CoolZxp" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/drindr"><img src="https://avatars.githubusercontent.com/u/34709601?v=4?s=100" width="100px;" alt="Drin"/><br /><sub><b>Drin</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=drindr" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://hzu.lol/"><img src="https://avatars.githubusercontent.com/u/42469039?v=4?s=100" width="100px;" alt="Hakim Zulkufli"/><br /><sub><b>Hakim Zulkufli</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=hakimzulkufli" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://bit.ly/2N1ynXZ"><img src="https://avatars.githubusercontent.com/u/14874913?v=4?s=100" width="100px;" alt="Simon Klakegg"/><br /><sub><b>Simon Klakegg</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=sklakegg" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/sudorest"><img src="https://avatars.githubusercontent.com/u/214225921?v=4?s=100" width="100px;" alt="Kiwi"/><br /><sub><b>Kiwi</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=sudorest" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://trade.xyz/?ref=BZ1RJRXWO"><img src="https://avatars.githubusercontent.com/u/7317522?v=4?s=100" width="100px;" alt="Raxxoor"/><br /><sub><b>Raxxoor</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=dhaern" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/nyanyani"><img src="https://avatars.githubusercontent.com/u/11475482?v=4?s=100" width="100px;" alt="nyanyani"/><br /><sub><b>nyanyani</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=nyanyani" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://nettee.io/"><img src="https://avatars.githubusercontent.com/u/3953668?v=4?s=100" width="100px;" alt="nettee"/><br /><sub><b>nettee</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=nettee" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/atomlink-ye"><img src="https://avatars.githubusercontent.com/u/48194045?v=4?s=100" width="100px;" alt="Link"/><br /><sub><b>Link</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=atomlink-ye" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/blaszewski"><img src="https://avatars.githubusercontent.com/u/14119531?v=4?s=100" width="100px;" alt="Bartosz Łaszewski"/><br /><sub><b>Bartosz Łaszewski</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=blaszewski" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/huilang021x"><img src="https://avatars.githubusercontent.com/u/77293911?v=4?s=100" width="100px;" alt="huilang021x"/><br /><sub><b>huilang021x</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=huilang021x" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/dkovacevic15"><img src="https://avatars.githubusercontent.com/u/24757821?v=4?s=100" width="100px;" alt="Dusan Kovacevic"/><br /><sub><b>Dusan Kovacevic</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=dkovacevic15" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/jwcrystal"><img src="https://avatars.githubusercontent.com/u/121911854?v=4?s=100" width="100px;" alt="jwcrystal"/><br /><sub><b>jwcrystal</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=jwcrystal" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://zenstudio.cv/"><img src="https://avatars.githubusercontent.com/u/10528635?v=4?s=100" width="100px;" alt="Nguyen Canh Toan"/><br /><sub><b>Nguyen Canh Toan</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=ZenStudioLab" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/tom-dyar"><img src="https://avatars.githubusercontent.com/u/8899513?v=4?s=100" width="100px;" alt="Thomas Dyar"/><br /><sub><b>Thomas Dyar</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=tom-dyar" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/zuuky"><img src="https://avatars.githubusercontent.com/u/6713415?v=4?s=100" width="100px;" alt="zero"/><br /><sub><b>zero</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=zuuky" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/DenisBalan"><img src="https://avatars.githubusercontent.com/u/33955091?v=4?s=100" width="100px;" alt="Denis Balan"/><br /><sub><b>Denis Balan</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=DenisBalan" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/gustavocaiano"><img src="https://avatars.githubusercontent.com/u/104129313?v=4?s=100" width="100px;" alt="Gustavo Caiano"/><br /><sub><b>Gustavo Caiano</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=gustavocaiano" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/ThomasMldr"><img src="https://avatars.githubusercontent.com/u/6631765?v=4?s=100" width="100px;" alt="Thomas Mulder"/><br /><sub><b>Thomas Mulder</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=ThomasMldr" title="Code">💻</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

---

## 📄 License

MIT

---
