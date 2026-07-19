<div align="center">
  <a href="https://github.com/alvinunreal/oh-my-opencode-slim/stargazers">
    <img src="img/v2.webp" alt="oh-my-opencode-slim V2 Release" style="border-radius: 10px;">
  </a>
  <h3>✨ oh-my-opencode-slim ✨</h3>

  <p><i>Seven divine beings emerged from the dawn of code, each an immortal master of their craft,<br>awaiting your command to forge order from chaos and build what was once thought impossible.</i></p>

  <p><b>Opencode Multi Agent Suite</b> · Mix any models · Auto delegate tasks</p>
  <p><sub>by <b>Boring Dystopia Development</b></sub></p>
  <p>
    <a href="https://boringdystopia.ai/"><img src="https://img.shields.io/badge/boringdystopia.ai-111111?style=for-the-badge&logo=vercel&logoColor=white" alt="boringdystopia.ai"></a>&nbsp;
    <a href="https://x.com/alvinunreal"><img src="https://img.shields.io/badge/X-@alvinunreal-000000?style=for-the-badge&logo=x&logoColor=white" alt="X @alvinunreal"></a>&nbsp;
    <a href="https://t.me/boringdystopiadevelopment"><img src="https://img.shields.io/badge/Telegram-Join%20channel-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram Join channel"></a>&nbsp;
  </p>

  <p>
    <b>English</b> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja-JP.md">日本語</a> | <a href="README.ko-KR.md">한국어</a>
  </p>

  <p><sub>✦ ✦ ✦</sub></p>

</div>

## What's This Plugin

oh-my-opencode-slim is an agent orchestration plugin for OpenCode. It includes a built-in team of specialized agents that can scout a codebase, look up fresh documentation, review architecture, handle UI work, and execute well-scoped implementation tasks under one orchestrator.

The main idea is simple: instead of forcing one model to do everything, the plugin routes each part of the job to the agent best suited for it, balancing **quality, speed and cost**. The Orchestrator plans the work graph, dispatches specialists as background tasks, and reconciles their results before continuing.

### ✨ Highlights

- **[Seven specialized agents](#meet-the-pantheon)** - Orchestrator, Explorer,
  Oracle, Council, Librarian, Designer, and Fixer. Each part of the job goes to
  the agent best suited for it - mix any models across any providers.
- **[Background orchestration](docs/background-orchestration.md)** - the
  Orchestrator dispatches specialists as background tasks, tracks them, and
  reconciles results before continuing - parallel work by default.
- **[Bundled skills](#skills)** - prompt-based workflows like `deepwork`,
  `codemap`, `verification-planning`, and `reflect`, assigned per agent.
- **[Council](docs/council.md)** - run multiple models in parallel on the same
  question and synthesize a single answer with `@council`.
- **[Companion](docs/companion.md)** - an optional floating desktop window
  showing which agents are active, including parallel background specialists.
- **[Multiplexer integration](docs/multiplexer-integration.md)** - watch agents
  work live in Tmux, Zellij, Herdr, cmux, or kitty panes.
- **[Preset switching](docs/preset-switching.md)** - swap the whole team's
  models at runtime with `/preset`.
- **[Code intelligence tools](docs/tools.md)** - LSP tools, AST-aware search
  across 25 languages, and built-in MCPs for web search, docs, and GitHub code
  search.
- **[Fully customizable](docs/configuration.md)** - custom agents, prompt
  overrides, per-agent skill/MCP permissions, and
  [project-local customization](docs/project-local-customization.md).

### OpenAI GPT-5.6

<p align="center">
  <img src="img/openai-gpt-5-6-pantheon.jpeg" alt="OpenAI GPT-5.6 Pantheon: Terra, Sol, and Luna" width="100%">
</p>

The default [OpenAI preset](docs/openai-preset.md) maps Terra to Orchestrator,
Sol to Oracle, and Luna to the fast specialist lanes.

### What Users Say

> “Task management went from 5/10 to 8-9/10 easily. The Orchestrator sends
> Fixers and Explorers, and I can still talk and plan with the Orchestrator in
> the same session. The experience feels way smoother now.”
>
> \- `vipor_idk`

> “I ditched all my harnesses for this beta version of omo-slim and don't look
> back or miss anything. Great work and IMHO all in the right direction.”
>
> \- `stephanschielke`

> “I love omo-slim, and can't imagine running opencode without it. I love that I
> can create a Frankenstein of models... Makes the setup such a beast.”
>
> \- `Capital-One3039`

> “It has significantly improved my workflow... Now, it is working very
> smoothly, and I love it.”
>
> \- `xenstar1`

### Quick Start

Copy and paste this prompt to your LLM agent (Claude Code, AmpCode, Cursor, etc.):


```
Install and configure oh-my-opencode-slim: https://raw.githubusercontent.com/alvinunreal/oh-my-opencode-slim/refs/heads/master/README.md
```


### Manual Installation

```bash
bunx oh-my-opencode-slim@latest install
```

The published CLI is a Node-compatible bundle, so `npx` works too if you don't
have Bun installed:

```bash
npx oh-my-opencode-slim@latest install
```

### Run from Master

Use this if you want the latest code, easier bug fixes, or a local setup for
development and contributions:

```bash
git clone https://github.com/alvinunreal/oh-my-opencode-slim.git ~/repos/oh-my-opencode-slim
cd ~/repos/oh-my-opencode-slim
bun install
bun run build
bun dist/cli/index.js install
```

The installer adds the local repo path to the `plugin` array in
`~/.config/opencode/opencode.json`, so OpenCode loads the plugin from that
folder. To update later:

```bash
cd ~/repos/oh-my-opencode-slim
git pull
bun install
bun run build
```

### Getting Started

The installer generates both OpenAI and OpenCode Go presets, with OpenAI active by default.

> [!TIP]
> Tune the models and agents for your own workflow. The defaults are only a
> starting point; the plugin is designed for deep flexibility and customization.

To make OpenCode Go active during install, run `bunx oh-my-opencode-slim@latest install --preset=opencode-go` or change the default preset name in `~/.config/opencode/oh-my-opencode-slim.json` after installation.

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
> It's **recommended** to understand how background orchestration works. The **[Orchestrator prompt](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/src/agents/orchestrator.ts#L28)** contains the scheduler rules, specialist routing logic, and thresholds for when work should be assigned to background agents. You can always delegate manually by calling a subagent via: `@agentName <task>`

> [!TIP]
> Because background agents are now the default workflow, it is **highly recommended** to enable and configure **[Multiplexer Integration](docs/multiplexer-integration.md)**. It automatically opens each agent in a dedicated Tmux, Zellij, Herdr, cmux, or kitty pane, so you can watch specialists work live while the Orchestrator continues coordinating the session.

The default generated configuration includes both `openai` and `opencode-go` presets.

```jsonc
{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json",
  "preset": "openai",
  "presets": {
    "openai": {
      "orchestrator": { "model": "openai/gpt-5.6-terra", "variant": "medium", "skills": ["*"], "mcps": ["*", "!context7"] },
      "oracle": { "model": "openai/gpt-5.6-sol", "variant": "high", "skills": ["simplify"], "mcps": [] },
      "librarian": { "model": "openai/gpt-5.6-luna", "variant": "low", "skills": [], "mcps": ["websearch", "context7", "gh_grep"] },
      "explorer": { "model": "openai/gpt-5.6-luna", "variant": "low", "skills": [], "mcps": [] },
      "designer": { "model": "openai/gpt-5.6-luna", "variant": "medium", "skills": [], "mcps": [] },
      "fixer": { "model": "openai/gpt-5.6-luna", "variant": "medium", "skills": [], "mcps": [] }
    },
    "opencode-go": {
      "orchestrator": { "model": "opencode-go/minimax-m3", "variant": "max", "skills": [ "*" ], "mcps": [ "*", "!context7" ] },
      "oracle": { "model": "opencode-go/qwen3.7-max", "variant": "max", "skills": ["simplify"], "mcps": [] },
      "librarian": { "model": "opencode-go/deepseek-v4-flash", "variant": "high", "skills": [], "mcps": [ "websearch", "context7", "gh_grep" ] },
      "explorer": { "model": "opencode-go/deepseek-v4-flash", "variant": "max", "skills": [], "mcps": [] },
      "designer": { "model": "opencode-go/kimi-k2.7-code", "variant": "medium", "skills": [], "mcps": [] },
      "fixer": { "model": "opencode-go/deepseek-v4-flash", "variant": "high", "skills": [], "mcps": [] },
      "observer": { "model": "opencode-go/mimo-v2.5", "variant": "max", "skills": [], "mcps": [] }
    }
  }
}
```

### Preset Docs

- **[OpenAI Preset](docs/openai-preset.md)** — the default generated preset; runs all agents on OpenAI models.
- **[OpenCode Go Preset](docs/opencode-go-preset.md)** — runs the agents on OpenCode Go models; enables the Observer agent for visual analysis since its orchestrator model isn't multimodal.
- **[Author's Preset](docs/authors-preset.md)** — the exact config the author runs day to day, with third-party skills.
- **[$30 Preset](docs/thirty-dollars-preset.md)** — a mixed-provider setup built around Codex Plus and GitHub Copilot Pro for about $30/month.
- **[OpenCode Zen Free Preset](docs/opencode-zen-free-preset.md)** — every agent runs on an opencode free model; no usage cost.

### For Alternative Providers

To use custom providers or a mixed-provider setup, use **[Configuration](docs/configuration.md)** for the full reference.

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
      <b>Default Model:</b> <code>openai/gpt-5.6-terra (medium)</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>claude-fable-5</code> <code>claude-opus-4-8</code> <code>glm-5.2</code> <code>gpt-5.6-terra</code> <code>mimo-v2.5</code> <code>minimax-m3</code> <code>qwen3.7-plus</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> Choose your strongest planning and judgment model. Orchestrator is the workflow manager: it plans, schedules background specialists, reconciles results, and verifies outcomes, so it needs reliable instruction-following and high-level technical judgment more than raw worker throughput.
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
      <b>Default Model:</b> <code>openai/gpt-5.6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>deepseek-v4-flash</code> <code>gpt-5.3-codex</code>
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
      <b>Default Model:</b> <code>openai/gpt-5.6-sol (high)</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>claude-fable-5</code> <code>claude-opus-4-8</code> <code>deepseek-v4-pro</code> <code>glm-5.2</code> <code>gpt-5.6-sol</code> <code>qwen3.7-max</code>
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
      <b>Default Setup:</b> <code>Config-driven</code> - councillors come from <code>council.presets</code> and the Council agent model comes from your normal <code>council</code> agent config
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
      <b>Default Model:</b> <code>openai/gpt-5.6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>deepseek-v4-flash</code> <code>gpt-5.3-codex</code> <code>mimo-v2.5</code> <code>minimax-m2.7</code>
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
      <b>Default Model:</b> <code>openai/gpt-5.6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>gemini-3.5-flash</code> <code>kimi-k2.7-code</code> <code>minimax-m3</code>
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
      <b>Default Model:</b> <code>openai/gpt-5.6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>claude-sonnet-4-6</code> <code>deepseek-v4-flash</code> <code>gpt-5.6-luna</code> <code>kimi-k2.7-code</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> Choose a reliable coding model for scoped implementation work. Fixer receives a concrete plan or bounded instructions from Orchestrator, making it a good place for efficient execution tasks and straightforward code changes.
    </td>
  </tr>
</table>

---

## Optional Agents

### Observer: The Silent Witness

> [!NOTE]
> **Why a separate agent?** If your Orchestrator model is not multimodal, enable Observer to handle images, screenshots, and other visual files. Observer is disabled by default and gives the Orchestrator a dedicated multimodal reader without forcing you to change your main reasoning model. Set `disabled_agents: []` and an `observer` model in your configuration. The bundled `opencode-go` install preset does this automatically because its GLM Orchestrator is not multimodal. Omitting `image_routing` preserves existing conditional Observer behavior. Set `image_routing: "auto"` only when Observer is enabled, or `"direct"` to always pass image attachments to the Orchestrator.

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/observer.jpg" width="240" style="border-radius: 10px;">
      <br><sub><i>The eye that reads what others cannot.</i></sub>
    </td>
    <td width="70%" valign="top">

**Read-only visual analysis** - interprets images, screenshots, PDFs, and diagrams. Returns structured observations to the orchestrator without loading raw file bytes into the main context window.

- Images, screenshots, diagrams → `read` tool (native image support)
- PDFs and binary documents → `read` tool (text + structure extraction)
- **Disabled by default** - enable with `"disabled_agents": []` and configure a vision-capable model; installing with `--preset=opencode-go` enables it with `opencode-go/mimo-v2.5`. Image attachments route to Observer by default when it is enabled; set `"image_routing": "direct"` to keep them on the Orchestrator.

    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/observer.ts"><code>observer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Model:</b> <code>openai/gpt-5.6-luna</code> - <i>configure a vision-capable model to enable</i>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>mimo-v2.5</code> <code>qwen3.5-plus</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> Choose a vision-capable model if you want the agent to read screenshots, images, PDFs, and other visual files.
    </td>
  </tr>
</table>

---

<a id="skills"></a>

## 🧩 Skills

Skills are prompt-based instructions injected into an agent's system prompt to
guide decisions, workflows, and tool use. Unlike MCPs (which are running
servers), a skill runs no process — it is a focused playbook an agent activates
when the task calls for it. The installer bundles eight skills and keeps them
updated on plugin auto-update; local customizations are preserved.

> [!TIP]
> To discard local bundled-skill customizations and receive package updates, run
> `bunx oh-my-opencode-slim install --skills=force`. This deliberately replaces
> installed bundled skills with the package versions.

| Skill | Purpose | Default agent | How to invoke |
|:-----:|---------|---------------|---------------|
| <img src="img/skills/codemap.webp" width="120" alt="Codemap artifact"><br>[`codemap`](src/skills/codemap/SKILL.md) | Hierarchical repository maps so agents understand codebases without re-reading everything | `orchestrator` | `run codemap` |
| <img src="img/skills/deepwork.webp" width="120" alt="Deepwork artifact"><br>[`deepwork`](src/skills/deepwork/SKILL.md) | Structured workflow for large, risky, multi-phase coding sessions with review gates | `orchestrator` | `/deepwork <task>` |
| <img src="img/skills/verification-planning.webp" width="120" alt="Verification Planning artifact"><br>[`verification-planning`](src/skills/verification-planning/SKILL.md) | Plans a project-specific evidence path before non-trivial changes | `orchestrator` | automatic before non-trivial work |
| <img src="img/skills/simplify.webp" width="120" alt="Simplify artifact"><br>[`simplify`](src/skills/simplify/SKILL.md) | Behavior-preserving simplification for readability and maintainability | `oracle` | ask for simplification or during review |
| <img src="img/skills/worktrees.webp" width="120" alt="Worktrees artifact"><br>[`worktrees`](src/skills/worktrees/SKILL.md) | Git worktrees as safe, isolated coding lanes for risky or parallel work | `orchestrator` | `work in a worktree` |
| <img src="img/skills/clonedeps.webp" width="120" alt="Clonedeps artifact"><br>[`clonedeps`](src/skills/clonedeps/SKILL.md) | Clones dependency source locally so agents can inspect library internals | `orchestrator` | `clone dependencies` |
| <img src="img/skills/reflect.webp" width="120" alt="Reflect artifact"><br>[`reflect`](src/skills/reflect/SKILL.md) | Turns repeated workflow friction into reusable skills, agents, or config | `orchestrator` | `/reflect` |
| <img src="img/skills/oh-my-opencode-slim.webp" width="120" alt="oh-my-opencode-slim artifact"><br>[`oh-my-opencode-slim`](src/skills/oh-my-opencode-slim/SKILL.md) | Configures and safely improves the plugin setup itself | `orchestrator` | ask to tune your setup |

Skill assignments are permission grants — an agent can only activate skills it
has been given. Configure them per agent with the `skills` array in
`~/.config/opencode/oh-my-opencode-slim.json`: an explicit list, `"*"` for
everything, or `"!skill-name"` to deny one.

See **[Skills](docs/skills.md)** for full documentation, or browse the
illustrated overview at
**[ohmyopencodeslim.com/skills](https://ohmyopencodeslim.com/skills)**.

---

<a id="companion"></a>

## 🖥️ Companion

The optional Companion is a floating desktop status window for live agent
activity. It shows the current session state and which agents are active, so
background work is easier to follow at a glance.

<div align="center">
  <img src="img/companion.gif" alt="Companion showing active agents" width="600">
  <p><i>Left bottom visual companion.</i></p>
</div>

During interactive install, the installer asks whether to enable Companion and
defaults to `no`. For automation, enable it explicitly with:

```bash
bunx oh-my-opencode-slim@latest install --companion=yes
```

See **[Companion](docs/companion.md)** for configuration, positions, sizes, and
install details.

---

## 📚 Documentation

Use this section as a map: start with installation, then jump to features, configuration, or example presets depending on what you need.

<a id="features-and-workflows"></a>

### ✨ Features & Workflows

| Doc | What it covers |
|-----|----------------|
| **[Council](docs/council.md)** | Run multiple models in parallel and synthesize a single answer with `@council` |
| **[Custom Agents](docs/configuration.md#custom-agents)** | Define your own specialists with custom prompts, models, MCP access, and Orchestrator delegation rules |
| **[ACP Agents](docs/acp-agents.md)** | Connect external ACP-compatible agents such as Claude Code ACP or Gemini ACP as delegatable subagents |
| **[Multiplexer Integration](docs/multiplexer-integration.md)** | Watch agents work live in Tmux, Zellij, Herdr, cmux, or kitty panes |
| **[Codemap](docs/codemap.md)** | Generate hierarchical codemaps to understand large codebases faster |
| **[Clonedeps](docs/clonedeps.md)** | Clone selected dependency source into an ignored local workspace for inspection |
| **[Worktrees](docs/worktrees.md)** | Use `.slim/worktrees/` lanes for isolated parallel or risky coding work |
| **[Preset Switching](docs/preset-switching.md)** | Switch agent model presets at runtime with `/preset` |
| **[Interview](docs/interview.md)** | Turn rough ideas into a structured markdown spec through a browser-based Q&A flow |
| **[Companion](docs/companion.md)** | Floating window companion for parsing, help, and types |

### ⚙️ Config & Reference

| Doc | What it covers |
|-----|----------------|
| **[Installation Guide](docs/installation.md)** | Install the plugin, use CLI flags, reset config, and troubleshoot setup |
| **[Configuration](docs/configuration.md)** | Config file locations, JSONC support, prompt overrides, and full option reference |
| **[Project Customization](docs/project-local-customization.md)** | Repository-specific custom agents, prompt overrides, per-agent skills, and precedence |
| **[Background Orchestration](docs/background-orchestration.md)** | Scheduler-first orchestrator model built around native background subagents |
| **[Maintainer Guide](docs/maintainers.md)** | Issue triage rules, label meanings, support routing, and repo maintenance workflow |
| **[Skills](docs/skills.md)** | Bundled skills such as `simplify`, `codemap`, `clonedeps`, `deepwork`, `verification-planning`, `reflect`, `worktrees`, and `oh-my-opencode-slim` |
| **[MCPs](docs/mcps.md)** | `websearch`, `context7`, `gh_grep`, and how MCP permissions work per agent |
| **[Tools](docs/tools.md)** | Built-in tool capabilities like `webfetch`, LSP tools, code search, and formatters |

---

## 🏛️ Contributors

<div align="center">
  <p><i>The builders, debuggers, writers, and wanderers who have earned their place in the pantheon.</i></p>
  <p><sub>Every merged contribution leaves a mark on the realm.</sub></p>

  <!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-80-orange.svg?style=flat-square)](#contributors-)
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
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/maou-shonen"><img src="https://avatars.githubusercontent.com/u/22576780?v=4?s=100" width="100px;" alt="魔王少年(maou shonen)"/><br /><sub><b>魔王少年(maou shonen)</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=maou-shonen" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/jelasin"><img src="https://avatars.githubusercontent.com/u/97788570?v=4?s=100" width="100px;" alt="  Jelasin"/><br /><sub><b>  Jelasin</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=jelasin" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/hannespr"><img src="https://avatars.githubusercontent.com/u/40021505?v=4?s=100" width="100px;" alt="Hannes"/><br /><sub><b>Hannes</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=hannespr" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://qwtoe.github.io/"><img src="https://avatars.githubusercontent.com/u/36733893?v=4?s=100" width="100px;" alt="mooozfxs"/><br /><sub><b>mooozfxs</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=qwtoe" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/zackslash"><img src="https://avatars.githubusercontent.com/u/2040617?v=4?s=100" width="100px;" alt="Luke Hines"/><br /><sub><b>Luke Hines</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=zackslash" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/andrewylies"><img src="https://avatars.githubusercontent.com/u/103019336?v=4?s=100" width="100px;" alt="m.seomoon"/><br /><sub><b>m.seomoon</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=andrewylies" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/yolo2h"><img src="https://avatars.githubusercontent.com/u/10754850?v=4?s=100" width="100px;" alt="Yolo"/><br /><sub><b>Yolo</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=yolo2h" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/xinxingi"><img src="https://avatars.githubusercontent.com/u/49302071?v=4?s=100" width="100px;" alt="XinXing"/><br /><sub><b>XinXing</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=xinxingi" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/eltociear"><img src="https://avatars.githubusercontent.com/u/22633385?v=4?s=100" width="100px;" alt="Ikko Eltociear Ashimine"/><br /><sub><b>Ikko Eltociear Ashimine</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=eltociear" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/dev-wantap"><img src="https://avatars.githubusercontent.com/u/69743540?v=4?s=100" width="100px;" alt="GWANWOO KIM"/><br /><sub><b>GWANWOO KIM</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=dev-wantap" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/OmerFarukOruc"><img src="https://avatars.githubusercontent.com/u/7347742?v=4?s=100" width="100px;" alt="Omer Faruk Oruc"/><br /><sub><b>Omer Faruk Oruc</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=OmerFarukOruc" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://khallaf.uk/"><img src="https://avatars.githubusercontent.com/u/51155980?v=4?s=100" width="100px;" alt="Omar Mohamed Khallaf"/><br /><sub><b>Omar Mohamed Khallaf</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=omar-mohamed-khallaf" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Qesire"><img src="https://avatars.githubusercontent.com/u/102657430?v=4?s=100" width="100px;" alt="Knowingthesea_Qesire"/><br /><sub><b>Knowingthesea_Qesire</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Qesire" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="http://www.flyinghail.net/"><img src="https://avatars.githubusercontent.com/u/157430?v=4?s=100" width="100px;" alt="FENG Hao"/><br /><sub><b>FENG Hao</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=flyinghail" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/smatheusblu"><img src="https://avatars.githubusercontent.com/u/5666794?v=4?s=100" width="100px;" alt="Matheus Nogueira Silveira"/><br /><sub><b>Matheus Nogueira Silveira</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=smatheusblu" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/sktr"><img src="https://avatars.githubusercontent.com/u/44969514?v=4?s=100" width="100px;" alt="sktr"/><br /><sub><b>sktr</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=sktr" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/bobbyunknown"><img src="https://avatars.githubusercontent.com/u/62272380?v=4?s=100" width="100px;" alt="Insomnia"/><br /><sub><b>Insomnia</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=bobbyunknown" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/andrescastane"><img src="https://avatars.githubusercontent.com/u/13487870?v=4?s=100" width="100px;" alt="Andres Castañeda"/><br /><sub><b>Andres Castañeda</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=andrescastane" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://zaradacht.com/"><img src="https://avatars.githubusercontent.com/u/24251016?v=4?s=100" width="100px;" alt="Zaradacht Taifour (Zack)"/><br /><sub><b>Zaradacht Taifour (Zack)</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Zaradacht" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/fslse"><img src="https://avatars.githubusercontent.com/u/90545544?v=4?s=100" width="100px;" alt="fslse"/><br /><sub><b>fslse</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=fslse" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/linze0721"><img src="https://avatars.githubusercontent.com/u/178997622?v=4?s=100" width="100px;" alt="萧瑟"/><br /><sub><b>萧瑟</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=linze0721" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/SisyphusZheng"><img src="https://avatars.githubusercontent.com/u/146103794?v=4?s=100" width="100px;" alt="Zhi"/><br /><sub><b>Zhi</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=SisyphusZheng" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/824156793"><img src="https://avatars.githubusercontent.com/u/19755784?v=4?s=100" width="100px;" alt="lilili"/><br /><sub><b>lilili</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=824156793" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="http://mikehenke.com/"><img src="https://avatars.githubusercontent.com/u/119844?v=4?s=100" width="100px;" alt="Mike Henke"/><br /><sub><b>Mike Henke</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=mhenke" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/imVinayPandya"><img src="https://avatars.githubusercontent.com/u/5011197?v=4?s=100" width="100px;" alt="Vinay Pandya"/><br /><sub><b>Vinay Pandya</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=imVinayPandya" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/s-shank"><img src="https://avatars.githubusercontent.com/u/241541918?v=4?s=100" width="100px;" alt="Shank"/><br /><sub><b>Shank</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=s-shank" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://rgutzen.github.io/"><img src="https://avatars.githubusercontent.com/u/16289604?v=4?s=100" width="100px;" alt="Robin Gutzen"/><br /><sub><b>Robin Gutzen</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=rgutzen" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/dragon-Elec"><img src="https://avatars.githubusercontent.com/u/197374270?v=4?s=100" width="100px;" alt="Yash"/><br /><sub><b>Yash</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=dragon-Elec" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Jiajun0413"><img src="https://avatars.githubusercontent.com/u/184531967?v=4?s=100" width="100px;" alt="Liu Jiajun"/><br /><sub><b>Liu Jiajun</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Jiajun0413" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/umi008"><img src="https://avatars.githubusercontent.com/u/200843810?v=4?s=100" width="100px;" alt="Ulises Millán"/><br /><sub><b>Ulises Millán</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=umi008" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/HighColdHC"><img src="https://avatars.githubusercontent.com/u/35870222?v=4?s=100" width="100px;" alt="HighColdHC"/><br /><sub><b>HighColdHC</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=HighColdHC" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://hardcore.engineer/about"><img src="https://avatars.githubusercontent.com/u/401815?v=4?s=100" width="100px;" alt="Stephan Schielke"/><br /><sub><b>Stephan Schielke</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=stephanschielke" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/DanMaly"><img src="https://avatars.githubusercontent.com/u/69809112?v=4?s=100" width="100px;" alt="Daniel Maly"/><br /><sub><b>Daniel Maly</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=DanMaly" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Chewji9875"><img src="https://avatars.githubusercontent.com/u/126886556?v=4?s=100" width="100px;" alt="Chewji"/><br /><sub><b>Chewji</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Chewji9875" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/DanielMaly"><img src="https://avatars.githubusercontent.com/u/1443921?v=4?s=100" width="100px;" alt="Daniel Maly"/><br /><sub><b>Daniel Maly</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=DanielMaly" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://giuseppebellamacina.com/"><img src="https://avatars.githubusercontent.com/u/102151655?v=4?s=100" width="100px;" alt="Giuseppe Bellamacina"/><br /><sub><b>Giuseppe Bellamacina</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=GiuseppeBellamacina" title="Code">💻</a></td>
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
