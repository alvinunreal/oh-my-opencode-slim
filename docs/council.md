# Council Agent Guide

Multi-model consensus for cases where you want more than one model's judgment.

## Table of Contents

- [Overview](#overview)
- [Quick Setup](#quick-setup)
- [Configuration](#configuration)
- [Model Fallback Chain](#model-fallback-chain)
- [Choosing the Council Model vs Councillor Models](#choosing-the-council-model-vs-councillor-models)
- [Preset Examples](#preset-examples)
- [Role Prompts](#role-prompts)
- [Usage](#usage)
- [Compatibility Notes](#compatibility-notes)
- [Troubleshooting](#troubleshooting)

---

## Overview

The **Council agent** runs several **councillors** in parallel, then
synthesizes their outputs into one answer.

### What you get

- **Higher confidence** from cross-checking multiple models
- **Diverse perspectives** across providers or model families
- **Graceful degradation** when only some councillors return
- **Configurable presets** for different cost/speed trade-offs

### How it works

Each councillor in a preset is registered as a dynamic subagent named
`councillor-<name>` (e.g. `councillor-alpha`, `councillor-beta`), each
with its own configured model. The orchestrator dispatches all councillors
in parallel via OpenCode's native `task()` tool at depth 1, and each
councillor appears as its own TUI pane.

```text
User / Orchestrator
        |
        v
Council agent (@council, your configured synthesizer model)
        |
        +--> task(): councillor-alpha (configured model)
        +--> task(): councillor-beta  (configured model)
        +--> task(): councillor-gamma (configured model)
        |
        v
Council agent synthesizes councillor results
        |
        v
Final answer
```

The council agent waits for all councillors to respond (or fail), then
synthesizes their results into a single report.

---

## Quick Setup

Add a council model and at least one council preset to your plugin config:

`~/.config/opencode/oh-my-opencode-slim.json`

```jsonc
{
  "preset": "openai",
  "presets": {
    "openai": {
      "council": { "model": "openai/gpt-5.6" }
    }
  },
  "council": {
    "presets": {
      "default": {
        "alpha": { "model": "openai/gpt-5.6-luna" },
        "beta": { "model": "google/gemini-3-pro" },
        "gamma": { "model": "openai/gpt-5.3-codex" }
      }
    }
  }
}
```

Then use it directly:

```text
@council What is the safest migration strategy for this schema change?
```

---

## Configuration

### Top-level council config

```jsonc
{
  "council": {
    "default_preset": "default",

    "presets": {
      "default": {
        "alpha": { "model": "openai/gpt-5.6-luna" }
      }
    }
  }
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `presets` | object | - | **Required.** Named councillor presets |
| `default_preset` | string | `"default"` | Preset used when none is specified |

### Councillor config

Each entry inside a preset is one councillor:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string \| array | Yes | A `provider/model` string, or an ordered fallback chain tried until one responds |
| `variant` | string | No | Optional variant/reasoning setting (applies to chain entries without their own) |
| `prompt` | string | No | Optional role guidance prepended to the user prompt |

### Council agent (synthesizer) config

The **synthesizer model** is **not** configured inside `council.presets`.

Configure it using the normal agent system:

```jsonc
{
  "presets": {
    "openai": {
      "council": { "model": "openai/gpt-5.6", "variant": "high" }
    }
  }
}
```

Or with a global override:

```jsonc
{
  "agents": {
    "council": {
      "temperature": 0.2
    }
  }
}
```

---

## Model Fallback Chain

When `model` is a string, the councillor uses that single model.

When `model` is an array, the councillor walks the chain in order:

```jsonc
{
  "council": {
    "presets": {
      "review": {
        "reviewer": {
          "model": [
            "openai/gpt-5.6",
            { "id": "google/gemini-3-pro", "variant": "high" },
            "anthropic/claude-opus-4-6"
          ],
          "prompt": "Focus on bugs, edge cases, and failure modes."
        }
      }
    }
  }
}
```

Entries are `provider/model` strings or `{ "id", "variant" }` objects. The
councillor tries each entry in order until one responds. Empty responses are
retried once per entry; other failures advance to the next entry. The
councillor only fails once every entry in the chain is exhausted.

---

## Choosing the Council Model vs Councillor Models

There are **two separate model layers**:

1. **The Council agent model** — the model behind `@council` itself, which
   does the final synthesis.
2. **The councillor models** — the models that actually fan out in parallel,
   configured under `council.presets.<preset>.<councillor>.model`.

### Configure the Council agent when you want to change

- the **final synthesizer model**
- shared council-agent behavior like temperature or MCPs

### Configure councillors when you want to change

- which models participate in the vote
- model diversity
- role-specific reviewer / architect / optimizer behavior

### Important rule

`agents.councillor` can change shared councillor settings such as temperature,
MCPs, and skills, but **it does not choose the councillor model**.

Councillor models always come from:

`council.presets.<preset>.<councillor>.model`

---

## Preset Examples

### Minimal second opinion

```jsonc
{
  "presets": {
    "openai": {
      "council": { "model": "openai/gpt-5.6" }
    }
  },
  "council": {
    "presets": {
      "second-opinion": {
        "reviewer": { "model": "openai/gpt-5.6-luna" }
      }
    }
  }
}
```

### Balanced multi-provider council

```jsonc
{
  "presets": {
    "openai": {
      "council": { "model": "openai/gpt-5.6" }
    }
  },
  "council": {
    "default_preset": "balanced",
    "presets": {
      "balanced": {
        "alpha": { "model": "openai/gpt-5.6-luna" },
        "beta": { "model": "google/gemini-3-pro" },
        "gamma": { "model": "anthropic/claude-opus-4-6" }
      }
    }
  }
}
```

---

## Role Prompts

Each councillor can receive its own steering prompt:

```jsonc
{
  "council": {
    "presets": {
      "review-board": {
        "reviewer": {
          "model": "openai/gpt-5.6-luna",
          "prompt": "Focus on bugs, edge cases, and failure modes."
        },
        "architect": {
          "model": "google/gemini-3-pro",
          "prompt": "Focus on maintainability, boundaries, and long-term design."
        },
        "optimizer": {
          "model": "openai/gpt-5.3-codex",
          "prompt": "Focus on performance, latency, and resource usage."
        }
      }
    }
  }
}
```

The councillor sees:

```text
<role prompt>
---
<user prompt>
```

---

## Usage

### Invocation

```text
@council Should we use a job queue or an outbox pattern here?
```

The orchestrator may also delegate to `@council` for high-stakes or
ambiguous decisions.

### What you see

Each councillor appears as its own TUI pane, dispatched in parallel. As they
complete, their responses stream into the panes. Once all councillors have
responded (or failed), the council agent synthesizes their results.

### Output

Council responses include:

1. **Council Response** — the synthesized final answer.
2. **Per-Councillor Details** — each responding councillor's individual response,
   using the councillor names from the configured preset.
3. **Council Summary** — agreement, disagreement resolution, remaining
   uncertainty, and a consensus confidence rating of `unanimous`, `majority`,
   or `split`.

A footer tracks participation:

```text
---
*Council: 2/3 councillors responded (alpha: gpt-5.6-luna, beta: gemini-3-pro)*
```

### Failure behavior

| Scenario | Behavior |
|----------|----------|
| Some councillors fail | Synthesize from the successful ones |
| All councillors fail | Return an error |
| Preset has zero councillors | Return an error |

---

## Compatibility Notes

### Deprecated `master` fields

Older configs used `council.master` and several other `master`-prefixed
fields. These fields are deprecated and ignored.

`master.model` is still accepted as a temporary fallback for the **Council
agent model only** when no explicit `council` agent model is configured
elsewhere.

Prefer this instead:

```jsonc
{
  "presets": {
    "openai": {
      "council": { "model": "openai/gpt-5.6" }
    }
  }
}
```

### Reserved keys inside presets

- A preset key named `master` is ignored
- Legacy nested `councillors` objects are still accepted for backward
  compatibility

---

## Troubleshooting

### `@council` is missing

Council is only available when `config.council` exists.

Make sure your config includes a `council` block with at least one preset.

### Preset not found

Check:

1. the preset name is correct
2. it exists under `council.presets`
3. `default_preset` points to a real preset when omitted at runtime

### All councillors fail

Verify the configured model IDs exist in your OpenCode environment. Each
councillor model must be a valid `provider/model` identifier your OpenCode
setup can reach.
