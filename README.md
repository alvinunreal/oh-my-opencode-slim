<div align="center">
  <img src="img/team.png" alt="Pantheon agents" width="420">
  <p><i>Six divine beings emerged from the dawn of code, each an immortal master of their craft await your command to forge order from chaos and build what was once thought impossible.</i></p>
  <p><b>Open Multi Agent Suite</b> · Mix any models · Auto delegate tasks · Token-disciplined</p>
</div>

---

## Installation

```bash
bunx omoslim@latest install
```

Non-interactive (copy-paste ready):

```bash
bunx omoslim@latest install --no-tui --kimi=yes --openai=yes --antigravity=yes --chutes=yes --opencode-free=yes --opencode-free-model=auto --tmux=no --skills=yes
```

Then authenticate:

```bash
opencode auth login
```

Run `ping all agents` to verify everything works.

> **Models are fully customizable.** Edit `~/.config/opencode/omoslim.json` (or `.jsonc`) to assign any model to any agent.

**For LLM agents** — paste into Claude Code, Cursor, or any coding agent:

```
Install and configure by following the instructions here:
https://raw.githubusercontent.com/alvinunreal/omoslim/refs/heads/master/README.md
```

**Detailed guides:** [Installation](docs/installation.md) · [Antigravity](docs/antigravity.md) · [Tmux](docs/tmux-integration.md)

---

## How It Works

The plugin wires a team of specialist agents onto your OpenCode session. The **Orchestrator** is the only agent you talk to directly — it breaks your request into tasks and delegates each one to the right specialist.

### Delegation flow

```
You → Orchestrator → delegate_task(agent="librarian") → packet returned inline
                   → delegate_task(agent="explorer", wait=false) ─┐
                   → delegate_task(agent="fixer",    wait=false) ─┤
                                                                   └─ packet_context(id1,id2)
```

Each specialist runs in its own session with **only** the tools it needs. When it finishes, its output is compressed into a **packet** — a structured ≤2,500-char summary — before being returned to the Orchestrator. Raw outputs never enter the Orchestrator's context.

### Packets

Every delegate returns a YAML packet:

```yaml
tldr:
  - Key insight 1
evidence:
  - file:src/foo.ts:42-80
  - thread:abc123#context
  - https://docs.example.com/api
recommendation: Single clear action
next_actions:
  - Step 1
  - Step 2
```

- **Evidence** accepts `file:`, `thread:`, `cmd:`, or URL pointers — never raw content.
- **tldr / recommendation** must be original synthesis — no URLs, no code blocks.
- Size-enforced: packets exceeding 2,500 chars are caught and replaced with a fallback that points to the archived thread.

### Fallback packets

When a delegate's output can't be packaged (too large, invalid schema, extraction error), the Orchestrator receives a degraded packet with `[fallback: reason]` in its Options section:

```
## Options
[fallback: size limit exceeded]
```

The Orchestrator can then:
- **Quick peek (500 chars):** `resolve_pointer(pointer="thread:abc123#context")`
- **Full compression:** `delegate_task(agent="summarizer", prompt="Summarize thread:abc123")`

### resolve_pointer

A surgical inspection tool for the Orchestrator — dereferences `thread:`, `file:`, or `cmd:` pointers from packets. Quota of **3 per user request**, reset automatically at the start of each new task.

### Parallel execution

For independent tasks, launch all delegates with `wait=false` and retrieve results in one shot:

```
delegate_task(..., agent="explorer",  wait=false)  → pkt_aaa
delegate_task(..., agent="librarian", wait=false)  → pkt_bbb
packet_context(task_id="pkt_aaa,pkt_bbb", timeout=120000)
→ merged packet with deduplication + conflict detection
```

---

## The Agents

| Agent | Role | Delegates To | MCPs |
|-------|------|--------------|------|
| **Orchestrator** | Coordinator — the only agent you talk to | All | websearch |
| **Explorer** | Codebase search (glob, grep, AST) | — | — |
| **Librarian** | Live docs, API references | — | websearch, context7, grep_app |
| **Oracle** | High-stakes architectural decisions | — | — |
| **Designer** | UI/UX implementation | explorer | — |
| **Fixer** | Fast parallel implementation | explorer | — |
| **Summarizer** | Compresses oversized delegate output | — | — |

Auto-routing: omit `agent` in `delegate_task` and the task-router classifies the prompt and picks the right specialist.

### Orchestrator

Master delegator. Routes tasks, merges results, integrates packet output into your session. Talks to all specialists; none of them talk back to it directly — only packets do.

### Explorer

Parallel search specialist. Glob, grep, AST queries across the codebase. Fastest when you need to discover *what exists* before planning.

### Librarian

Authoritative source for current library docs. Fetches official docs and examples via Context7 and grep.app. Use for APIs that change frequently — React, Next.js, AI SDKs, ORMs.

### Oracle

Strategic advisor for high-stakes decisions and persistent problems. Slow, expensive, high-quality. Reserve for major architectural choices and bugs that survived 2+ fix attempts.

### Designer

UI/UX specialist. Visual direction, responsive layouts, design systems. Delegates discovery to Explorer when needed.

### Fixer

Fast parallel execution for well-defined tasks. Spawning multiple Fixers simultaneously is the standard pattern for 3+ independent changes.

### Summarizer

Compresses oversized delegate output. Called by the Orchestrator when a packet fallback contains `[fallback: size limit exceeded]` and a full re-summary is needed.

---

## Documentation

- **[Quick Reference](docs/quick-reference.md)** — Presets, Skills, MCPs, Tools, Configuration
- **[Installation Guide](docs/installation.md)** — Detailed installation and troubleshooting
- **[Cartography Skill](docs/cartography.md)** — Repo mapping + codemap generation
- **[Antigravity Setup](docs/antigravity.md)** — Antigravity (Google) provider configuration
- **[Tmux Integration](docs/tmux-integration.md)** — Real-time agent monitoring

---

## License

MIT

---

<!-- MoltFounders Banner -->
<a href="https://moltfounders.com/project/0f5874c7-9291-415b-9622-7509d96a2c73">
  <img src="img/moltfounders-banner.png" alt="MoltFounders - The Agent Co-Founder Network">
</a>
