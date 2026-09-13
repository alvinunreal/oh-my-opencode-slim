# Preset Switching

Select and persist a preset using the `/preset` TUI slash command. Effective agent/model changes apply only after plugin reload or a new conversation.

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
3. **Apply** persists the preset name to the config file only —
   the sidebar is NOT refreshed mid-session (the agent registry is unchanged
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

## Preset Inheritance

One preset can extend another by declaring an optional `$extends` field:

```jsonc
{
  "presets": {
    "base": {
      "orchestrator": { "model": "openai/gpt-5.6-terra" },
      "oracle": { "model": "openai/gpt-5.6-sol" }
    },
    "cheap": {
      "$extends": "base",
      "orchestrator": { "model": "anthropic/claude-3.5-haiku" }
    },
    "standalone": {
      "oracle": { "model": "openai/gpt-5.6-sol" }
    }
  }
}
```

`standalone` has no `$extends` and works as before. `cheap` extends `base`: it
inherits `oracle.model` and overrides `orchestrator.model`.

### Syntax

- `$extends` accepts a single, non-empty preset name, or `null`.
- `$extends: null` detaches a parent inherited from a lower-priority config
  layer (user config → project config). It does not delete any other fields.
- Existing presets without `$extends` are valid and behave identically to
  before — no migration needed.

### Layered Parent Resolution

User and project config layers are merged before inheritance resolution. When
both layers define the same preset:

- **Omitted `$extends`** in the higher layer preserves the lower layer's parent.
- **String `$extends`** in the higher layer replaces the lower layer's parent.
- **`null` `$extends`** in the higher layer detaches the lower layer's parent.

### Merge Precedence

Effective configuration applies in this order (later wins):

1. Oldest ancestor → … → immediate parent → selected child
2. Root `agents` overrides are applied last

Arrays and primitive values are replaced by the higher-precedence value.
Nested objects are deep-merged (keys from both sides are combined).

### Parent-Only Presets

A preset that exists only as an inheritance target is itself selectable.
`base` above can be chosen as the active preset and applies its own
configuration.

### Inheritance Graph Validation

Every preset in the merged user/project graph is validated eagerly at
startup. Missing parents and inheritance cycles are fatal: the entire
merged configuration is rejected and plugin startup fails with a diagnostic
naming the missing parent or cycle path.

This is a separate error class from malformed JSON or schema-invalid
configuration, which continue to produce warnings with an empty-config
fallback as before.

### Prompt Inheritance

Inline `prompt` and `orchestratorPrompt` fields are ordinary agent override
values, so they inherit through the parent chain. Parent preset **prompt
directories** (`oh-my-opencode-slim/<preset>/<agent>.md`) do **not** inherit —
prompt-file lookup remains scoped to the active preset and its existing
project/user search roots.

### TUI Behavior

- The TUI /preset manager preserves raw `$extends` metadata when reading,
  editing, saving, or deleting presets. `$extends` is not treated as an
  agent in summaries, counts, or aliases.
- Before saving, overwriting, or deleting a preset, the TUI validates the
  merged candidate graph (user layer + current project layer). A mutation
  that would introduce a missing parent or cycle is rejected, and the
  on-disk configuration is left unchanged.
- Selecting a parent-only preset works — the TUI uses the resolved
  inherited configuration for switching.

### Reload Behavior

Startup and reload-based disk switching apply resolved inheritance. The
resolved effective map (metadata-free) is used for agent construction,
model selection, and summaries. V1 does not define live runtime-preset
switching — the module-level runtime state in `runtime-preset.ts` is
outside this feature's scope.

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

These fields take effect only after reload: `prompt`, `skills`, `mcps`, `displayName`.

## Preset Activation Methods

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
