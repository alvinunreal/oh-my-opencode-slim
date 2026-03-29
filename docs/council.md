# Council Agent Guide

Multi-LLM consensus system that runs several models in parallel and synthesises their best thinking into one answer.

## Table of Contents

- [Overview](#overview)
- [Quick Setup](#quick-setup)
- [Configuration](#configuration)
- [Preset Examples](#preset-examples)
- [Role Prompts](#role-prompts)
- [Usage](#usage)
- [Timeouts & Error Handling](#timeouts--error-handling)
- [Troubleshooting](#troubleshooting)
- [Advanced](#advanced)

---

## Overview

The **Council agent** sends your prompt to multiple LLMs (councillors) in parallel, then passes all responses to a **council master** that synthesises the optimal answer. Think of it as asking three experts and having a senior referee pick the best parts.

### Key Benefits

- **Higher confidence** — consensus across models reduces single-model blind spots
- **Diverse perspectives** — different architectures catch different issues
- **Graceful degradation** — if the master fails, the best councillor response is returned
- **Configurable presets** — different council compositions for different tasks

### How It Works

```
User prompt
    │
    ├──────────────┬──────────────┐
    ▼              ▼              ▼
 Councillor A  Councillor B  Councillor C
 (model X)     (model Y)     (model Z)
🔍 read-only   🔍 read-only   🔍 read-only
    │              │              │
    └──────────────┴──────────────┘
                   │
                   ▼
            Council Master
            (synthesis model)
            🔒 no tools
                   │
                   ▼
           Synthesised response
```

---

## Quick Setup

### Step 1: Add Council Configuration

Edit `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`):

```jsonc
{
  "council": {
    "master": { "model": "anthropic/claude-opus-4-6" },
    "presets": {
      "default": {
        "alpha": { "model": "openai/gpt-5.4-mini" },
        "beta":  { "model": "google/gemini-3-pro" },
        "gamma": { "model": "openai/gpt-5.3-codex" }
      }
    }
  }
}
```

### Step 2: Use the Council Agent

Talk to the council agent directly:

```
@council What's the best approach for implementing rate limiting in our API?
```

Or let the orchestrator delegate when it needs multi-model consensus.

That's it — the council runs, synthesises, and returns one answer.

---

## Configuration

### Council Settings

Configure in `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`):

```jsonc
{
  "council": {
    "master": { "model": "anthropic/claude-opus-4-6" },
    "default_preset": "default",
    "presets": {
      "default": { /* councillors */ }
    },
    "master_timeout": 300000,
    "councillors_timeout": 180000
  }
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `master` | object | — | **Required.** Council master configuration (see below) |
| `master.model` | string | — | **Required.** Model ID in `provider/model` format |
| `master.variant` | string | — | Optional variant for the master model |
| `master.prompt` | string | — | Optional guidance for the master's synthesis (see [Role Prompts](#role-prompts)) |
| `presets` | object | — | **Required.** Named councillor presets (see below) |
| `default_preset` | string | `"default"` | Which preset to use when none is specified |
| `master_timeout` | number | `300000` | Master synthesis timeout in ms (5 minutes) |
| `councillors_timeout` | number | `180000` | Per-councillor timeout in ms (3 minutes) |
| `master_fallback` | string[] | — | Optional fallback models for the master. Tried in order if the primary model fails or times out |

### Councillor Configuration

Each councillor within a preset:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | Model ID in `provider/model` format |
| `variant` | string | No | Model variant (e.g., `"high"`, `"low"`) |
| `prompt` | string | No | Role-specific guidance injected into the councillor's user prompt (see [Role Prompts](#role-prompts)) |

### Per-Preset Master Override

Each preset can optionally override the global master's `model`, `variant`, and `prompt` using a reserved `"master"` key:

```jsonc
{
  "council": {
    "master": { "model": "anthropic/claude-opus-4-6" },
    "presets": {
      "fast-review": {
        "master": { "model": "openai/gpt-5.4" },
        "alpha": { "model": "openai/gpt-5.4-mini" },
        "beta":  { "model": "google/gemini-3-pro" }
      }
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `presets.<name>.master.model` | string | No | Overrides the global master model for this preset |
| `presets.<name>.master.variant` | string | No | Overrides the global master variant for this preset |
| `presets.<name>.master.prompt` | string | No | Overrides the global master prompt for this preset |

**Merge behaviour:** Each field uses nullish coalescing — if a field is omitted in the preset override, the global value is used. If no `"master"` key exists in the preset, the global master is used as-is.

**Reserved key:** `"master"` inside a preset is reserved for this override and is not treated as a councillor name. Any councillor named `"master"` will be ignored.

### Constraints

- Councillors run as **agent sessions with read-only codebase access** — they can read files, search by name (glob), search by content (grep), search by AST pattern (codesearch), and query the language server (LSP). They cannot modify files, run shell commands, or spawn subagents. This makes council responses grounded in actual code rather than guessing.
- The council master also runs as an agent session with zero permissions — synthesis is purely analytical.
- Councillor and council-master agents can be configured (model, temperature, MCPs, skills) via the standard `agents.councillor` and `agents.council-master` preset overrides.

---

## Preset Examples

### 1-Councillor: Second Opinion

Use a single councillor when you want a second model's take without overhead:

```jsonc
{
  "council": {
    "master": { "model": "anthropic/claude-opus-4-6" },
    "presets": {
      "second-opinion": {
        "reviewer": { "model": "openai/gpt-5.4" }
      }
    }
  }
}
```

**When to use:** Quick sanity check from a different model. The master still reviews the single response and can refine it.

### 2-Councillor: Compare & Contrast

Two councillors with different models:

```jsonc
{
  "council": {
    "master": { "model": "anthropic/claude-opus-4-6" },
    "presets": {
      "compare": {
        "analyst":  { "model": "openai/gpt-5.4" },
        "creative": { "model": "google/gemini-3-pro" }
      }
    }
  }
}
```

**When to use:** Architecture decisions where you want perspectives from two different providers.

### 3-Councillor: Balanced Council

The default setup — three diverse models:

```jsonc
{
  "council": {
    "master": { "model": "anthropic/claude-opus-4-6" },
    "presets": {
      "default": {
        "alpha": { "model": "openai/gpt-5.4-mini" },
        "beta":  { "model": "google/gemini-3-pro" },
        "gamma": { "model": "openai/gpt-5.3-codex" }
      }
    }
  }
}
```

**When to use:** General-purpose consensus. Good balance of speed, cost, and diversity.

### N-Councillor: Full Review Board

As many councillors as you need — the system runs them all in parallel:

```jsonc
{
  "council": {
    "master": { "model": "anthropic/claude-opus-4-6" },
    "presets": {
      "full-board": {
        "alpha":   { "model": "anthropic/claude-opus-4-6" },
        "bravo":   { "model": "openai/gpt-5.4" },
        "charlie": { "model": "openai/gpt-5.3-codex" },
        "delta":   { "model": "google/gemini-3-pro" },
        "echo":    { "model": "openai/gpt-5.4-mini" }
      }
    },
    "councillors_timeout": 300000
  }
}
```

**When to use:** High-stakes design reviews or complex architectural decisions where maximum model diversity matters. Increase `councillors_timeout` since there are more responses to collect.

### Multiple Presets

Define several presets and choose at invocation time:

```jsonc
{
  "council": {
    "master": { "model": "anthropic/claude-opus-4-6" },
    "default_preset": "balanced",
    "presets": {
      "quick": {
        "fast": { "model": "openai/gpt-5.4-mini" }
      },
      "balanced": {
        "alpha": { "model": "openai/gpt-5.4-mini" },
        "beta":  { "model": "google/gemini-3-pro" }
      },
      "heavy": {
        "analyst":   { "model": "anthropic/claude-opus-4-6" },
        "coder":     { "model": "openai/gpt-5.3-codex" },
        "reviewer":  { "model": "google/gemini-3-pro" }
      }
    }
  }
}
```

**How to select a preset:**

| Caller | How |
|--------|-----|
| User via `@council` | The council agent can pass a `preset` argument to the `council_session` tool |
| Orchestrator delegates | Orchestrator invokes `@council`, which selects the preset |
| No preset specified | Falls back to `default_preset` (defaults to `"default"`) |

---

### Role Prompts

Both councillors and the master accept an optional `prompt` field that injects role-specific guidance into the user prompt. This lets you steer each participant's behaviour without changing the system prompt.

**Councillor prompt** — prepended to the user prompt before the divider:

```
<role prompt>
---
<user prompt>
```

**Master prompt** — appended after the synthesis instruction:

```
<synthesis instruction>

---
**Master Guidance**:
<role prompt>
```

#### Example: Specialised Review Board

Both councillors and the master accept an optional `prompt` field. The master prompt can be set globally (`council.master.prompt`) or per-preset (`presets.<name>.master.prompt`):

```jsonc
{
  "council": {
    "master": { "model": "anthropic/claude-opus-4-6" },
    "presets": {
      "review-board": {
        "master": {
          "prompt": "Prioritise correctness and security over creativity. Flag any risks."
        },
        "reviewer": {
          "model": "openai/gpt-5.4",
          "prompt": "You are a meticulous code reviewer. Focus on edge cases, error handling, and potential bugs."
        },
        "architect": {
          "model": "google/gemini-3-pro",
          "prompt": "You are a systems architect. Focus on design patterns, scalability, and maintainability."
        },
        "optimiser": {
          "model": "openai/gpt-5.3-codex",
          "prompt": "You are a performance specialist. Focus on latency, throughput, and resource usage."
        }
      }
    }
  }
}
```

#### Example: Per-Preset Master Model + Councillor Prompt

Override the master model for a specific preset while customising one councillor's role:

```jsonc
{
  "council": {
    "master": { "model": "anthropic/claude-opus-4-6" },
    "presets": {
      "fast": {
        "master": { "model": "openai/gpt-5.4" },
        "alpha": { "model": "openai/gpt-5.4-mini" },
        "beta": {
          "model": "google/gemini-3-pro",
          "prompt": "Respond as a devil's advocate. Challenge assumptions and find weaknesses."
        }
      }
    }
  }
}
```

Without a `prompt`, the councillor or master uses its default behaviour — no changes to the prompt.

---

## Usage

### Direct Invocation (User)

Talk to the council agent like any other agent:

```
@council Should we use event sourcing or CRUD for the order service?
```

The council agent delegates to `council_session` internally and returns the synthesised result.

### Orchestrator Delegation

The orchestrator can delegate to `@council` when it needs multi-model consensus:

```
This is a high-stakes architectural decision. @council, get consensus on the database migration strategy.
```

The orchestrator's prompt includes guidance on when to delegate to council:

> **Delegate when:** Critical decisions needing diverse model perspectives • High-stakes architectural choices where consensus reduces risk • Ambiguous problems where multi-model disagreement is informative

### Reading the Output

Council responses include a summary footer:

```
<synthesised answer>

---
*Council: 3/3 councillors responded (alpha: gpt-5.4-mini, beta: gemini-3-pro, gamma: gpt-5.3-codex)*
```

If some councillors failed:

```
<synthesised answer from available councillors>

---
*Council: 2/3 councillors responded (alpha: gpt-5.4-mini, beta: gemini-3-pro)*
```

---

## Timeouts & Error Handling

### Timeout Behaviour

| Timeout | Default | Scope |
|---------|---------|-------|
| `councillors_timeout` | 180000 ms (3 min) | Per-councillor — each councillor gets this much time |
| `master_timeout` | 300000 ms (5 min) | Master synthesis — one timeout for the whole synthesis phase |

Councillors that don't respond in time are marked `timed_out`. The master proceeds with whatever results came back.

### Graceful Degradation

| Scenario | Behaviour |
|----------|-----------|
| Some councillors fail | Master synthesises from the survivors |
| All councillors fail | Returns error immediately — master is never invoked |
| Master primary model fails | Tries `master_fallback` models in order before degrading |
| All master models fail | Returns best single councillor response prefixed with `(Degraded — master failed, using <name>'s response)` |

### Master Fallback Chain

The council master can be configured with fallback models. If the primary master model fails (timeout, API error, rate limit), the system tries each fallback in order before degrading to the best councillor response. This uses the same abort-retry pattern as the background task manager.

```jsonc
{
  "council": {
    "master": { "model": "anthropic/claude-opus-4-6" },
    "master_fallback": ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4"],
    "presets": { /* ... */ }
  }
}
```

When not configured, the master uses a single model with no fallback.

---

## Troubleshooting

### Council Not Available

**Problem:** `@council` agent doesn't appear or tool is missing

**Solutions:**
1. Verify `council` is configured in your plugin config:
   ```bash
   cat ~/.config/opencode/oh-my-opencode-slim.json | grep -A 5 '"council"'
   ```
2. Ensure `master.model` and at least one preset with one councillor are defined
3. Restart OpenCode after config changes

### All Councillors Timing Out

**Problem:** "All councillors failed or timed out"

**Solutions:**
1. **Increase timeout:**
   ```jsonc
   { "council": { "councillors_timeout": 300000 } }
   ```
2. **Verify model IDs** — models must be in `provider/model` format and available in your OpenCode configuration
3. **Check provider connectivity** — ensure the model providers are reachable

### Preset Not Found

**Problem:** `Preset "xyz" not found`

**Solutions:**
1. Check the preset name matches exactly (case-sensitive)
2. Verify the preset exists under `council.presets` in your config
3. If not specifying a preset, check `default_preset` points to an existing one

### Subagent Depth Exceeded

**Problem:** "Subagent depth exceeded"

This happens when the council is nested too deep (council calling council, or orchestrator → council → council). The default max depth is 3.

**Solutions:**
1. Avoid patterns where the orchestrator delegates to council, which then delegates back to orchestrator
2. Use council as a leaf agent — it should not be chained recursively

---

## Advanced

### Model Selection Strategy

Choose models from **different providers** for maximum perspective diversity:

| Strategy | Example |
|----------|---------|
| Diverse providers | OpenAI + Google + Anthropic |
| Same provider, different tiers | `gpt-5.4` + `gpt-5.4-mini` |
| Specialised models | Codex (code) + GPT (reasoning) + Gemini (analysis) |

### Cost Considerations

- Each councillor is one agent session → N councillors = N sessions + 1 master session. Councillors may use multiple tool calls within their session (read, grep, etc.), which increases token usage but grounds responses in actual code.
- Use smaller/faster models as councillors and a stronger model as master, unless you are willing to spend the tokens on parallel frontier models.
- The 1-councillor preset is the most cost-effective (2 calls total)

### Council Agent Mode

The council agent is registered with `mode: "all"` in the OpenCode SDK, meaning it works as both:

- **Primary agent** — users can talk to it directly via `@council`
- **Subagent** — the orchestrator can delegate to it

This is intentional: council is useful both as a user-facing tool for deliberate consensus-seeking and as a subagent the orchestrator can invoke for high-stakes decisions.

### Customising Councillor & Master Agents

Councillor and council-master are registered agents, so you can customise them using the standard `agents` override system:

```jsonc
{
  "agents": {
    "councillor": {
      "model": "openai/gpt-5.4",
      "temperature": 0.3,
      "mcps": ["grep_app", "context7"]
    },
    "council-master": {
      "model": "anthropic/claude-opus-4-6",
      "variant": "high"
    }
  }
}
```

**Defaults:**
| Agent | Model | MCPs | Skills | Temperature |
|-------|-------|------|--------|-------------|
| `councillor` | `openai/gpt-5.4-mini` | none | none | 0.2 |
| `council-master` | `openai/gpt-5.4-mini` | none | none | 0.1 |

**Note:** Per-councillor model overrides in the council config (`presets.<name>.<councillor>.model`) take precedence over the agent-level default.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Plugin Entry                          │
│                    (src/index.ts)                        │
│                                                         │
│  config.council?                                        │
│    ├── CouncilManager (session orchestration)           │
│    ├── council_session tool (agent-gated)               │
│    ├── SubagentDepthTracker (recursion guard)           │
│    │                                                     │
│    └── Agent Sessions                                    │
│        ├── councillor (read-only, 🔍)                   │
│        │   └── deny all + allow: read, glob, grep,      │
│        │       lsp, list, codesearch                     │
│        └── council-master (zero tools, 🔒)              │
│            └── deny all + question: deny                 │
│                                                         │
│  Agent Registration                                     │
│    ├── council: mode "all" (user + orchestrator)        │
│    ├── councillor: mode "subagent", hidden              │
│    └── council-master: mode "subagent", hidden          │
└─────────────────────────────────────────────────────────┘
```
