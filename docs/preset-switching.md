# Preset Switching

Switch agent model presets at runtime without restarting OpenCode using the `/preset` slash command.

## Controls

| Command | Description |
|---------|-------------|
| `/preset` | List available presets (highlights the active one) |
| `/preset <name>` | Switch to the named preset immediately |

## How It Works

1. Define named presets in `oh-my-opencode-slim.jsonc` under the `presets` field
2. Run `/preset <name>` to switch. The plugin calls the OpenCode SDK's `config.update()` method, which triggers a server-side cache invalidation
3. The next LLM call uses the new models and settings

## Example Configuration

```jsonc
{
  "presets": {
    "cheap": {
      "orchestrator": { "model": "anthropic/claude-3.5-haiku" },
      "explorer": { "model": "openai/gpt-5.4-mini" },
      "oracle": { "model": "anthropic/claude-sonnet-4-6" }
    },
    "powerful": {
      "orchestrator": { "model": "openai/gpt-5.5" },
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

The following fields are forwarded to the OpenCode SDK at runtime:

| Field | Description |
|-------|-------------|
| `model` | Model ID in `provider/model` format. Array form (fallback chains) is resolved to the first entry |
| `temperature` | Inference temperature (0-2) |
| `variant` | Model variant (e.g. `"thinking"`) |
| `options` | Provider-specific options (e.g. thinking budget) |

Fields not forwarded (require restart): `prompt`, `skills`, `mcps`, `displayName`.

## Startup Preset vs Runtime Switching

There are two ways to activate a preset:

| Method | How | Persists? |
|--------|-----|-----------|
| Config file | Set `"preset": "cheap"` in `oh-my-opencode-slim.jsonc` | Yes, across restarts |
| `/preset` command | Run `/preset cheap` during a session | No, reverts on restart |

On restart, the plugin's `config()` hook re-applies the preset from the config file, overwriting any runtime switch. To make a runtime switch permanent, update the `"preset"` field in your config file.

## Example Output

```
/preset
```

```
Available presets:
  cheap ← active
    orchestrator → anthropic/claude-3.5-haiku
    explorer → openai/gpt-5.4-mini
    oracle → anthropic/claude-sonnet-4-6
  powerful
    orchestrator → openai/gpt-5.5
    oracle → anthropic/claude-opus-4-6

Usage: /preset <name> to switch.
```

```
/preset powerful
```

```
Switched to preset "powerful":
orchestrator → model: openai/gpt-5.5
oracle → model: anthropic/claude-opus-4-6
```

> See [Configuration](configuration.md) for the full preset option reference.
