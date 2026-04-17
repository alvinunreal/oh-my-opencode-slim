<div align="center">
  <img src="img/team.png" alt="Pantheon agents" style="border-radius: 10px;" width="620">
  <p><i>Seven divine beings emerged from the dawn of code, each an immortal master of their craft await your command to forge order from chaos and build what was once thought impossible.</i></p>
  <p><b>Open Multi Agent Suite</b> · Mix any models · Auto delegate tasks</p>
  <p><a href="https://moltfounders.com/jobs/09d1c6e7-9e0e-4683-8d78-e2376aaa2333"><img src="https://moltfounders.com/badges/4.png" alt="MoltFounders" height="30"></a></p>
  <p><sub>by <b>Boring Dystopia Development</b></sub></p>
  <p>
    <a href="https://boringdystopia.ai/"><img src="https://img.shields.io/badge/boringdystopia.ai-111111?style=for-the-badge&logo=vercel&logoColor=white" alt="boringdystopia.ai"></a>&nbsp;
    <a href="https://x.com/alvinunreal"><img src="https://img.shields.io/badge/X-@alvinunreal-000000?style=for-the-badge&logo=x&logoColor=white" alt="X @alvinunreal"></a>&nbsp;
    <a href="https://t.me/boringdystopiadevelopment"><img src="https://img.shields.io/badge/Telegram-Join%20channel-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram Join channel"></a>
  </p>
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
bunx oh-my-opencode-slim@latest install --no-tui --tmux=yes --skills=yes
```

To force overwrite of an existing configuration:
```bash
bunx oh-my-opencode-slim@latest install --reset
```

### For Alternative Providers

The default configuration uses OpenAI. To use Kimi, GitHub Copilot, or ZAI Coding Plan, see **[Provider Configurations](docs/provider-configurations.md)** for step-by-step instructions and config examples.

> [!TIP]
> Want to see the latest models OpenCode knows about? Run `opencode models --refresh` to refresh the cache and list currently available models.

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

### 07. Observer: The Silent Witness

> [!NOTE]
> **Why a separate agent?** Not all models support vision. Your strongest coding model (e.g. for design decisions) may not be able to read images, while a vision-capable model may not be the best for reasoning. Observer solves this by having its **own model** — configure a vision-capable model for it while keeping Designer on your strongest reasoning model. Disabled by default; enable via `disabled_agents: []` in config.

<table>
  <tr>
    <td width="240" valign="top">
      <b>Observer</b><br>
      <i>Visual & binary analysis</i>
    </td>
    <td>

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
| **Interview** | [interview.md](docs/interview.md) | Browser-based Q&A flow for turning rough ideas into a live markdown spec |
| **Multiplexer Integration** | [multiplexer-integration.md](docs/multiplexer-integration.md) | Watch agents work in real-time with auto-spawned panes (Tmux/Zellij) |
| **Cartography Skill** | [cartography.md](docs/cartography.md) | Auto-generate hierarchical codemaps for any codebase |

### ⚙️ Config & Reference

| Doc | Contents |
|-----|----------|
| **[Skills](docs/skills.md)** | `simplify`, `agent-browser`, `cartography` — assignment syntax |
| **[MCPs](docs/mcps.md)** | `websearch`, `context7`, `grep_app` — permissions per agent |
| **[Tools](docs/tools.md)** | Background tasks, LSP, local `grep`, AST-grep, formatters |
| **[Configuration](docs/configuration.md)** | Config files, prompt overriding, JSONC, full option reference |

Slim only intercepts `apply_patch` before native execution. It rewrites recoverable stale patches, canonizes safe tolerant matches against the real file when unicode/trim drift is the only mismatch, keeps the authored `new_lines` bytes intact, preserves existing file EOL/final-newline state for updates, validates malformed patches strictly before helper execution, uses a conservative bounded LCS fallback, supports sequential `Update File` hunks on the same path through accumulated helper state, and blocks `apply_patch` before the native tool runs if any patch path falls outside the allowed root/worktree. This rescue does not extend to `edit` or `write`.

### 💡 Presets

| Doc | Contents |
|-----|----------|
| **[Author's Preset](docs/authors-preset.md)** | The exact config the author runs daily — OpenAI Pro + GitHub Copilot |
| **[$30 Preset](docs/thirty-dollars-preset.md)** | A mixed setup using Codex Plus ($20) + GitHub Copilot Pro ($10) for about $30/month total |

---

## 🏛️ Contributors

<div align="center">
  <p><i>The builders, debuggers, writers, and wanderers who have earned their place in the pantheon.</i></p>
  <p><sub>Every merged contribution leaves a mark on the realm.</sub></p>

  <!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-38-orange.svg?style=flat-square)](#contributors-)
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
