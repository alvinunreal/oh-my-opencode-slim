# Anthropic Preset

The `anthropic` preset uses the Claude model family for all agents, optimizing for
cost and capability by assigning each agent the right Claude tier:

- **Haiku** for lightweight, high-frequency tasks (librarian, explorer, fixer)
- **Sonnet** for core engineering work (orchestrator, designer)
- **Opus** for deep reasoning and long-horizon planning (oracle)

This preset is available out of the box — no extra configuration needed beyond
having an Anthropic API key (or using OpenRouter).

---

## Model assignment

| Agent | Model | Variant | Role |
|---|---|---|---|
| orchestrator | `anthropic/claude-sonnet-4.6` | — | Task decomposition and agent routing |
| oracle | `anthropic/claude-opus-4.7` | high | Deep architecture and planning decisions |
| librarian | `anthropic/claude-haiku-4.5` | low | Fast documentation and search tasks |
| explorer | `anthropic/claude-haiku-4.5` | low | Codebase traversal and discovery |
| designer | `anthropic/claude-sonnet-4.6` | medium | UI and interface design |
| fixer | `anthropic/claude-haiku-4.5` | low | Targeted bug fixes and small edits |

---

## Activating the preset

### At install time

```bash
bunx oh-my-opencode-slim@latest install --preset=anthropic
```

### By editing your config

In `~/.config/opencode/oh-my-opencode-slim.json`, set the active preset:

```jsonc
{
  "preset": "anthropic",
  "presets": {
    "anthropic": { /* generated automatically */ }
  }
}
```

### Switching at runtime

Use the `/preset` slash command inside an OpenCode session:

```
/preset anthropic
```

---

## Authentication

Log in to Anthropic (or OpenRouter) before starting:

```bash
opencode auth login
opencode models --refresh
```

---

## Cost profile

Approximate costs at typical usage (token prices as of 2025):

| Model | Input | Output |
|---|---|---|
| claude-haiku-4.5 | $1 / 1M | $5 / 1M |
| claude-sonnet-4.6 | $3 / 1M | $15 / 1M |
| claude-opus-4.7 | $5 / 1M | $25 / 1M |

Because Haiku handles the three most frequent roles (librarian, explorer,
fixer), the majority of token spend lands on the cheapest tier.
