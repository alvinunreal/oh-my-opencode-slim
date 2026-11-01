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
in parallel via the host's native delegation tool (`task()` on v1,
`subagent()` on v2) at depth 1, and each
councillor appears as its own TUI pane.

A seat session receives only the prompt it is dispatched with — nothing else
from the parent conversation — so the orchestrator embeds a brief summary of
the needed context into each seat prompt. Councillors do have read-only
codebase tools (read/glob/grep and friends); that boundary is enforced by
permission config, never by prompt text.

Once every councillor has responded (or the orchestrator's bounded wait on
a silent seat expires — see [Failure behavior](#failure-behavior)), the
orchestrator calls the council agent with the question plus a final
`Seats: <id, id>` line listing the session IDs the seat dispatches returned;
the harness resolves those IDs and attaches the full stored responses
before the call runs, so the orchestrator never re-types the seat text
itself. The
council agent itself waits for no one: it has no tools and starts from
whatever its context carries.

> With the managed lifecycle **off** (native OpenCode v2 delegation, no
> plugin job board), the same `Seats:` line still resolves: the seat hook
> reads each child session and its transcript directly from the host —
> never the parent's transcript — instead of the board. The prompt format
> does not change, and one call-start cutoff guards attribution: a seat
> whose newest prompt arrived at or after the synthesis call opened
> reports `[no response — unverified result]` rather than replaying an
> older answer (see [What you see](#what-you-see)).

### Who dispatches whom

The **orchestrator** dispatches all councillor seats and the council
synthesizer — the council agent itself dispatches nobody (it has no tools):

```text
User / Orchestrator
        |
        +--> task(): councillor-alpha (configured model)   } dispatched
        +--> task(): councillor-beta  (configured model)   } in parallel
        +--> task(): councillor-gamma (configured model)   } by the orchestrator
        |
        v
task(subagent_type='council', prompt=<question + 'Seats: <id, id>' line>)
        |
        v   harness resolves the returned IDs and attaches every seat response
Council agent (no tools) synthesizes the responses
        |
        v
Structured report: Council Response / Per-Councillor Details / Council Summary
```

> The diagram shows v1 wording; on v2 the same dispatches use `subagent()`.

### Why councillors stay independent

Councillors never see each other's responses. Each seat is dispatched
with only the prompt it needs, and the council agent synthesizes all of
them afterward. This is deliberate — the reason a council beats a single
model is that seats on different models make *different* mistakes, not
that they get to argue.

Measured finding-level overlap between same-model reviewers runs 52–62%;
across different models it drops to 37–46%. A three-seat council is
already the mix of differently-biased reviewers that does the work.
Adding a stage where seat B critiques seat A would trade that
independence away for a review round with no measured accuracy gain
behind it — and [a repeated-review study](https://arxiv.org/abs/2603.16244)
found recall gains outweighed by precision and F1 degradation as false
positives grew.

The practical corollary when you build a lineup: **seat quality outranks
seat count.** In testing, the spread between the strongest and weakest
reviewer model was larger than the entire spread across all same-model
setups, and the weakest reviewer scored below baseline self-review. A seat
that fails over to a weak model dilutes the council rather than adding
to it.

Full reasoning, evidence, and the alternatives that were ruled out:
[ADR-002: Council seats stay independent](adr/002-council-seat-independence.md).

---

## Quick Setup

Add a council model and at least one council preset to your plugin config:

`~/.config/opencode/oh-my-opencode-slim.json`

```jsonc
{
  "preset": "openai",
  "presets": {
    "openai": {
      "council": { "model": "openai/gpt-6" }
    }
  },
  "council": {
    "presets": {
      "default": {
        "alpha": { "model": "openai/gpt-6-luna" },
        "beta": { "model": "google/gemini-3-pro" },
        "gamma": { "model": "openai/gpt-5.3-codex" }
      }
    }
  }
}
```

Then ask for it in your message. Council Mode is **keyword-triggered**: the
orchestrator's static prompt carries only the seat roster (a `## Council`
line listing the seats), and the `council-inject` hook watches orchestrator
user messages and injects the full Council Mode procedure **once** — on the
first message that carries a trigger. The block then stays in history as a
standing procedure: later triggers don't re-inject it, so the token cost is
paid once per session, not per trigger. Code blocks and inline code are
stripped before matching, and slash commands never trigger:

- **English**: `council` / `@council`, `councillor`, `consensus`,
  `second opinion`, `roundtable`, `multiple opinions`, `multiple models`,
  `several models`, `multi-model`, `multi-agent`, `panel`, `deliberate`,
  `deliberation`, `diverse perspectives`, `sounding board`
- **简体中文**: `议会`, `顾问团`, `圆桌`, `共识`, `第二意见`, `多方意见`,
  `多模型`, `多个模型`, `几个模型`, `别的模型`, `其他模型`, `多代理`, `多智能体`
- **日本語**: `評議会`, `協議会`, `円卓`, `合意`, `セカンドオピニオン`,
  `複数のモデル`, `マルチエージェント`
- **한국어**: `평의회`, `위원회`, `원탁`, `합의`, `세컨드 오피니언`,
  `여러 모델`, `멀티에이전트`
- **فارسی**: `شورا`, `انجمن`, `میزگرد`, `اجماع`, `نظر دوم`, `چند مدل`, `چندعامله`

```text
Run a council: what is the safest migration strategy for this schema change?
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
        "alpha": { "model": "openai/gpt-6-luna" }
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
| `prompt` | string | No | Optional role guidance appended to the councillor's system prompt |

### Council agent (synthesizer) config

The **synthesizer model** is **not** configured inside `council.presets`.

Configure it using the normal agent system:

```jsonc
{
  "presets": {
    "openai": {
      "council": { "model": "openai/gpt-6", "variant": "high" }
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
            "openai/gpt-6",
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

Two model layers: the **Council agent** model (`@council`, the final synthesis)
and the **councillor** models that fan out in parallel. Configure the Council
agent to change the synthesizer or shared council behavior; configure
councillors to change who votes, model diversity, or role behavior.
`agents.councillor` can set shared councillor options (temperature, MCPs,
skills) but **never** the councillor model — that always comes from
`council.presets.<preset>.<councillor>.model`.

---

## Preset Examples

```jsonc
{
  "presets": {
    "openai": {
      "council": { "model": "openai/gpt-6" }
    }
  },
  "council": {
    "default_preset": "balanced",
    "presets": {
      "balanced": {
        "alpha": { "model": "openai/gpt-6-luna" },
        "beta": { "model": "google/gemini-3-pro" },
        "gamma": { "model": "anthropic/claude-opus-4-6" }
      }
    }
  }
}
```

A single-councillor preset uses the same shape with one entry.

---
## Role Prompts

Each councillor can receive its own steering prompt:

```jsonc
{
  "council": {
    "presets": {
      "review-board": {
        "reviewer": {
          "model": "openai/gpt-6-luna",
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

The councillor sees the role prompt appended to the tail of its **system
prompt** (not the user prompt):

```text
<councillor system prompt>

<role prompt>
```

---

## Usage

### Invocation

Ask for consensus in your message — see the [trigger list](#quick-setup)
above; the first trigger keyword in a session injects the Council Mode
procedure (once — later triggers don't re-inject), and the orchestrator
dispatches every councillor seat in parallel:

```text
Should we use a job queue or an outbox pattern here? Get a council's opinion.
```

The orchestrator may also run a council on its own for high-stakes or
ambiguous decisions. The injection is keyword-triggered and paid once per
session, so sessions that never ask pay zero tokens for the procedure.

**Disabling injection.** Turn the keyword injection off entirely with
`disabled_hooks: ["council-inject"]` (see
[Hooks](configuration.md#hooks)). The council agent and councillor seats
stay available — you can still dispatch them by name — but the automatic
procedure injection no longer happens. The seat roster in the orchestrator
prompt remains as the only static cost; with the hook disabled it grows a
one-line manual dispatch hint (`Seats: ... — dispatch via <tool>() when the
user asks for consensus.`) because no procedure block will ever appear.

**Disabling the council.** Listing `council` in `disabled_agents` disables
the whole chain (council agent, councillor seats, seat pointer, keyword
injection). Without council config at all, the chain is never built.

### What you see

Each councillor is dispatched in parallel as its own TUI pane while it
runs; when idle, councillors are hidden from the @-mention menu (they are
still dispatchable by name). As they complete, their responses stream into
the panes. Once all councillors have responded (or failed), the
orchestrator calls the council agent with a `Seats: <id, id>` line of the
dispatch-returned session IDs, and
the harness attaches the collected responses to that call; the council
agent synthesizes the report.

Which resolver attaches them depends on configuration, and the prompt does
not change: with the managed lifecycle on, seat text comes from the parent's
job board (aliases or session IDs both resolve); with the managed lifecycle
off (`backgroundJobs.mode: "native"` or `"off"`, or the legacy
`backgroundJobs.enabled: false`), it comes from the host sessions directly —
only exact `ses_` IDs resolve, each child must still report this parent, and
the seat body is the child's latest answer. Text from an earlier round is
never replayed: a seat still working on its newest prompt reports
`[no response — still running]`, an unreadable session reports
`[no response — unverified result]`, and a seat whose newest prompt arrived at
or after the synthesis call opened reports `[no response — unverified result]`
too — its transcript can no longer be attributed to this council run.

### Output

Council responses include:

1. **Council Response** — the synthesized final answer.
2. **Per-Councillor Details** — each responding councillor's individual response,
   using the councillor names from the configured preset.
3. **Council Summary** — agreement, disagreement resolution, remaining
   uncertainty, and a consensus confidence rating of `unanimous`, `majority`,
   or `split`.

### Failure behavior

| Scenario | Behavior |
|----------|----------|
| Some councillors fail | Synthesize from the successful ones; failed seats are marked in the report |
| All councillors fail | The report lists every seat as failed; there is no synthesized answer to present |
| Empty seat response | Retried once, then marked as failed if still empty |

---

## Compatibility Notes

### Removed `master` fields

The `council.master*` keys were removed: ignored with a warning (see
[Removed config keys](configuration.md#removed-config-keys)).

Prefer this instead:

```jsonc
{
  "presets": {
    "openai": {
      "council": { "model": "openai/gpt-6" }
    }
  }
}
```

### Reserved keys inside presets

- A preset key named `master` was removed: the entry is ignored with a warning.
- Nested legacy `councillors` objects were removed: the wrapper and the
  councillors inside it are ignored with a warning. Put councillors directly
  under the preset.

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
