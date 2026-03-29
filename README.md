<div align="center">
  <img src="img/team.png" alt="Pantheon agents" style="border-radius: 10px;" width="620">
  <p><i>Seven divine beings emerged from the dawn of code, each an immortal master of their craft await your command to forge order from chaos and build what was once thought impossible.</i></p>
  <p><b>Open Multi Agent Suite</b> · Mix any models · Auto delegate tasks</p>
  <p><a href="https://moltfounders.com/jobs/09d1c6e7-9e0e-4683-8d78-e2376aaa2333"><img src="https://moltfounders.com/badges/4.png" alt="MoltFounders" height="30"></a></p>
</div>

---

## 📦 Installation

### Quick Start

```bash
bunx oh-my-opencode-slim@latest install
```

The installer generates an OpenAI configuration by default (using `gpt-5.4` and `gpt-5.4-mini`). No provider questions asked.

For non-interactive mode:

```bash
bunx oh-my-opencode-slim@latest install --no-tui --tmux=no --skills=yes
```

To force overwrite of an existing configuration:
```bash
bunx oh-my-opencode-slim@latest install --reset
```

### For Alternative Providers

The default configuration uses OpenAI. To use Kimi, GitHub Copilot, or ZAI Coding Plan, see **[Provider Configurations](docs/provider-configurations.md)** for step-by-step instructions and config examples.

### JSON Schema

An official JSON Schema is included in the package for editor validation and autocomplete. Add a `$schema` reference to your config file:

```jsonc
{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json",
  // your config...
}
```

This enables autocomplete and inline validation in VS Code, Neovim, and other editors that support JSON Schema.

### For LLM Agents

Paste this into any coding agent:

```
Install and configure by following the instructions here:
https://raw.githubusercontent.com/alvinunreal/oh-my-opencode-slim/refs/heads/master/README.md
```

**Detailed installation guide:** [docs/installation.md](docs/installation.md)

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
  <p><i>Confirmation that all six agents are online and ready.</i></p>
</div>

If any agent fails to respond, check your provider authentication and config file.

---

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
      <b>Default Model:</b> <code>openai/gpt-5.4</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>openai/gpt-5.4</code> <code>anthropic/claude-opus-4.6</code>
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
      <b>Default Model:</b> <code>openai/gpt-5.4 (high)</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>openai/gpt-5.4 (high)</code> <code>google/gemini-3.1-pro-preview (high)</code>
    </td>
  </tr>
</table>

---

### Council: The Chorus of Minds

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/council.png" width="240" style="border-radius: 10px;">
      <br><sub><i>Many minds, one verdict.</i></sub>
    </td>
    <td width="70%" valign="top">
      The Council is not a lone being but a chamber of minds summoned when one answer is not enough. It sends your question to multiple models in parallel, gathers their competing judgments, and places them before a master who distills the strongest ideas into a single verdict. Where a solitary agent may miss a path, the Council cross-examines possibility itself.
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
      <b>Default Setup:</b> <code>Config-driven</code> — council master + councillors are chosen from your configured preset
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Setup:</b> <code>Strong master</code> + <code>diverse councillors</code> across providers
    </td>
  </tr>
</table>

---

### 04. Librarian: The Weaver of Knowledge

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
</table>

---

### 05. Designer: The Guardian of Aesthetics

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
</table>

---

### 06. Fixer: The Last Builder

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
</table>

---

## 📚 Documentation

### 🚀 Getting Started

| Doc | Contents |
|-----|----------|
| **[Installation Guide](docs/installation.md)** | CLI flags, `--reset`, auth, troubleshooting |
| **[Provider Configurations](docs/provider-configurations.md)** | OpenAI, Kimi, Copilot, ZAI, Fireworks AI — mixing providers, fallback chains |

### ✨ Features

| Feature | Doc | What it does |
|---------|-----|--------------|
| **Council** | [council.md](docs/council.md) | Run N models in parallel, synthesize one answer (`@council`) |
| **Tmux Integration** | [tmux-integration.md](docs/tmux-integration.md) | Watch agents work in real-time with auto-spawned panes |
| **Cartography Skill** | [cartography.md](docs/cartography.md) | Auto-generate hierarchical codemaps for any codebase |

### ⚙️ Config & Reference

| Doc | Contents |
|-----|----------|
| **[Skills](docs/skills.md)** | `simplify`, `agent-browser`, `cartography` — assignment syntax |
| **[MCPs](docs/mcps.md)** | `websearch`, `context7`, `grep_app` — permissions per agent |
| **[Tools](docs/tools.md)** | Background tasks, LSP, code search, formatters |
| **[Configuration](docs/configuration.md)** | Config files, prompt overriding, JSONC, full option reference |

### 💡 Author's Setup

| Doc | Contents |
|-----|----------|
| **[Author's Preset](docs/authors-preset.md)** | The exact config the author runs daily — OpenAI + Fireworks AI + GitHub Copilot |

---

## 📄 License

MIT

---

<!-- MoltFounders Banner -->
<a href="https://moltfounders.com/jobs/09d1c6e7-9e0e-4683-8d78-e2376aaa2333">
  <img src="img/moltfounders-banner.png" alt="MoltFounders - The Agent Co-Founder Network">
</a>
