# Council Agent Guide

Multi-model consensus for cases where you want more than one model's judgment.

## Table of Contents

- [Overview](#overview)
- [The Important Mental Model](#the-important-mental-model)
- [Quick Setup](#quick-setup)
- [Configuration](#configuration)
- [Choosing the Council Model vs Councillor Models](#choosing-the-council-model-vs-councillor-models)
- [Preset Examples](#preset-examples)
- [Role Prompts](#role-prompts)
- [Usage](#usage)
- [Timeouts, Retries, and Failures](#timeouts-retries-and-failures)
- [Compatibility Notes](#compatibility-notes)
- [Troubleshooting](#troubleshooting)

---

## Overview

The **Council agent** runs several **councillors** in parallel, then the
**Council agent itself** synthesizes their outputs into one answer.

### What you get

- **Higher confidence** from cross-checking multiple models
- **Diverse perspectives** across providers or model families
- **Graceful degradation** when only some councillors return
- **Configurable presets** for different cost/speed trade-offs

### How it works

```text
User / Orchestrator
        |
        v
Council agent (@council, your configured synthesizer model)
        |
        +--> launches Councillor A (preset model)
        +--> launches Councillor B (preset model)
        +--> launches Councillor C (preset model)
        |
        v
Council agent synthesizes councillor results
        |
        v
Final answer
```

---

## The Important Mental Model

There are **two separate model layers**:

1. **The Council agent model**
   - This is the model behind `@council` itself.
   - It does the final synthesis.
   - Configure it like any other agent: via your active preset's `council`
     entry or `agents.council` override.

2. **The councillor models**
   - These are the models that actually fan out in parallel.
   - Configure them under `council.presets.<preset>.<councillor>.model`.

If you only remember one thing, remember this:

> `@council` uses the normal agent config for the synthesizer model, and
> `council.presets` for the fan-out councillor models.

---

## Quick Setup

Add a council model and at least one council preset to your plugin config:

`~/.config/opencode/oh-my-opencode-slim.json`

```jsonc
{
  "preset": "openai",
  "presets": {
    "openai": {
      "council": { "model": "openai/gpt-5.5" }
    }
  },
  "council": {
    "presets": {
      "default": {
        "alpha": { "model": "openai/gpt-5.4-mini" },
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
    "timeout": 180000,
    "councillor_execution_mode": "parallel",
    "councillor_retries": 3,
    "presets": {
      "default": {
        "alpha": { "model": "openai/gpt-5.4-mini" }
      }
    }
  }
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `presets` | object | — | **Required.** Named councillor presets |
| `default_preset` | string | `"default"` | Preset used when none is specified |
| `timeout` | number | `180000` | Per-councillor timeout in ms |
| `councillor_execution_mode` | string | `"parallel"` | `parallel` runs all councillors concurrently; `serial` runs them one at a time |
| `councillor_retries` | number | `3` | Retries per councillor on empty provider responses |

### Councillor config

Each entry inside a preset is one councillor:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | Model ID in `provider/model` format |
| `variant` | string | No | Optional variant/reasoning setting |
| `prompt` | string | No | Optional role guidance prepended to the user prompt |

### Council agent config

The **synthesizer model** is **not** configured inside `council.presets`.

Configure it using the normal agent system:

```jsonc
{
  "presets": {
    "openai": {
      "council": { "model": "openai/gpt-5.5", "variant": "high" }
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

## Choosing the Council Model vs Councillor Models

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
      "council": { "model": "openai/gpt-5.5" }
    }
  },
  "council": {
    "presets": {
      "second-opinion": {
        "reviewer": { "model": "openai/gpt-5.4-mini" }
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
      "council": { "model": "openai/gpt-5.5" }
    }
  },
  "council": {
    "default_preset": "balanced",
    "presets": {
      "balanced": {
        "alpha": { "model": "openai/gpt-5.4-mini" },
        "beta": { "model": "google/gemini-3-pro" },
        "gamma": { "model": "anthropic/claude-opus-4-6" }
      }
    }
  }
}
```

### Serial mode for single-model systems

```jsonc
{
  "council": {
    "councillor_execution_mode": "serial",
    "presets": {
      "default": {
        "alpha": { "model": "openai/gpt-5.4-mini" },
        "beta": { "model": "openai/gpt-5.4-mini" }
      }
    }
  }
}
```

Use `serial` when parallel councillor launches would contend for the same
underlying provider/session limits.

---

## Role Prompts

Each councillor can receive its own steering prompt:

```jsonc
{
  "council": {
    "presets": {
      "review-board": {
        "reviewer": {
          "model": "openai/gpt-5.4-mini",
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

### Direct invocation

```text
@council Should we use a job queue or an outbox pattern here?
```

### Via orchestrator delegation

The orchestrator may delegate to `@council` for high-stakes or ambiguous
decisions, but it does so sparingly because council is usually the most
expensive path.

### Output format

Council responses include:

1. `Council Response` — the synthesized final answer.
2. `Councillor Details` — each responding councillor's individual response,
   using the councillor names from the configured preset.
3. `Council Summary` — agreement, disagreement resolution, remaining
   uncertainty, and a consensus confidence rating of `unanimous`, `majority`,
   or `split`.

### Output footer

Council responses include a footer like:

```text
---
*Council: 2/3 councillors responded (alpha: gpt-5.4-mini, beta: gemini-3-pro)*
```

---

## Timeouts, Retries, and Failures

### Timeout behavior

- `timeout` is **per councillor**
- timed-out councillors are marked `timed_out`
- council still synthesizes from successful results

### Empty response retries

Some providers silently return zero tokens. Council treats that as a retryable
failure.

- `councillor_retries` defaults to `3`
- retries only happen for **empty provider responses**
- normal failures and timeouts are returned immediately

### Failure behavior

| Scenario | Behavior |
|----------|----------|
| Some councillors fail | Synthesize from the successful ones |
| All councillors fail | Return an error |
| Preset has zero councillors | Return an error |

---

## Compatibility Notes

### Deprecated `master` fields

Older examples used these fields:

- `council.master`
- `council.master_timeout`
- `council.master_fallback`

They are deprecated.

Current behavior:

- `master_timeout` is ignored
- `master_fallback` is ignored
- `master` is deprecated, but `master.model` is still accepted as a temporary
  fallback for the **Council agent model only** when no explicit `council`
  agent model is configured elsewhere

Prefer this instead:

```jsonc
{
  "presets": {
    "openai": {
      "council": { "model": "openai/gpt-5.5" }
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

Council tools are only registered when `config.council` exists.

Make sure your config includes a `council` block with at least one preset.

### Preset not found

Check:

1. the preset name is correct
2. it exists under `council.presets`
3. `default_preset` points to a real preset when omitted at runtime

### All councillors timed out

Try:

```jsonc
{
  "council": {
    "timeout": 300000
  }
}
```

Also verify the configured model IDs exist in your OpenCode environment.

### Subagent depth exceeded

Council is meant to be a leaf agent. Avoid recursive council chains.
