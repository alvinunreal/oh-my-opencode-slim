# Preset Switching

Switch agent model presets at runtime using the `/preset` TUI slash command.

## Controls

`/preset` opens a **three-level preset manager** in the TUI — pure TUI, like
the built-in `/models`, so it triggers no LLM turn.

| Level | What you do |
|-------|-------------|
| 1. Preset list | Apply / Edit / Delete an existing preset, or create a new one |
| 2. Agent arrangement | Add / remove / edit the agents in a preset, then Save (or Save & Apply) |
| 3. Edit agent | Pick model → variant (thinking strength) → temperature → options (JSON) |

> `/preset` is a TUI-only slash command (like `/models`). Invoke it via
> autocomplete selection or a keybind. Typing `/preset` + Enter does not open
> the manager (same design as `/models`).

## How It Works

1. Define named presets in `oh-my-opencode-slim.jsonc` under the `presets`
   field, or create them interactively from the manager
2. The manager writes preset changes to the user config file
3. **Apply** persists the preset name to the config file only — the
   sidebar is NOT refreshed mid-session (the agent registry is unchanged
   until reload; showing new models against running agents would be
   misleading)
4. **Reload OpenCode** (or start a new conversation) for the new preset to
   take effect on the agent registry
5. The current session is **not** reloaded — this is deliberate.
   Hot-swapping the agent tree mid-conversation could truncate context (a
   new model may have a smaller window), drift prior assistant turns under
   a changed system prompt, leave running subagents referencing stale agent
   definitions, or shift tool/skill availability. A future path to true
   in-session switching without reset requires a host API for atomic
   agent-registry refresh with session compatibility checks.

### Level 3 — model and variant selection

The model picker lists every model from all connected providers (fetched from
the server's provider registry). If the chosen model exposes variants (e.g.
`thinking`, `high`, `low`), a variant picker follows — this is the "thinking
strength" selector. Temperature is a numeric prompt (0–2 or blank). Options is
a raw JSON prompt for provider-specific settings (e.g.
`{"thinking":{"type":"enabled","budgetTokens":10000}}`).

## Example Configuration

```jsonc
{
  "presets": {
    "cheap": {
      "orchestrator": { "model": "anthropic/claude-3.5-haiku" },
      "explorer": { "model": "openai/gpt-5.6-luna" },
      "oracle": { "model": "anthropic/claude-sonnet-4-6" }
    },
    "powerful": {
      "orchestrator": { "model": "openai/gpt-5.6" },
      "oracle": { "model": "anthropic/claude-opus-4-6" },
      "librarian": { "model": "anthropic/claude-sonnet-4-6" }
    },
    "thinking": {
      "oracle": {
        "model": "anthropic/claude-sonnet-4-6",
        "variant": "thinking",
        "options": { "thinking": { "type": "enabled", "budgetTokens": 10000 } }
      }
    }
  }
}
```

## Supported Fields

The following fields are applied when the preset is loaded on restart:

| Field | Description |
|-------|-------------|
| `model` | Model ID in `provider/model` format. Array form (fallback chains) is resolved to the first entry |
| `temperature` | Inference temperature (0-2) |
| `variant` | Model variant (e.g. `"thinking"`) |
| `options` | Provider-specific options (e.g. thinking budget) |

Fields not applied at runtime (require restart): `prompt`, `skills`, `mcps`, `displayName`.

## Startup Preset vs Runtime Switching

There are two ways to activate a preset:

| Method | How | Persists? |
|--------|-----|-----------|
| Config file | Set `"preset": "cheap"` in `oh-my-opencode-slim.jsonc` | Yes, across restarts |
| `/preset` TUI command | Select a preset from the picker during a session | Yes — writes to config file |

The `/preset` TUI command writes the selected preset name to the config file,
so the switch persists across restarts. **Reload OpenCode** for the new preset
to take effect on the agent registry. The current session continues
uninterrupted with its existing models.

> See [Configuration](configuration.md) for the full preset option reference.
