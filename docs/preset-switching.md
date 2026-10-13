# Preset Switching

Switch agent model presets at runtime using the `/preset` TUI slash command.

## Controls

`/preset` opens a **three-level preset manager** in the TUI — pure TUI, like
the built-in `/models`, so it triggers no LLM turn.

| Level | What you do |
|-------|-------------|
| 1. Preset list | Apply / Edit / Delete an existing preset, or create a new one |
| 2. Agent arrangement | Choose a Base preset, add / remove / edit local agents, then Save (or Save & Apply) |
| 3. Edit agent | Pick model → variant (thinking strength) → temperature → options (JSON) |

> `/preset` is a TUI-only slash command (like `/models`). On v1 hosts invoke
> it via autocomplete selection or a keybind — typing `/preset` + Enter does
> not open the manager (same design as `/models`), and it takes no name
> argument.
>
> On v2 hosts, typing `/preset` + Enter opens the same three-level manager,
> and the sidebar's active-preset row opens it on click. `/preset <name>`
> stays the fast path: it persists the named preset and requests the live
> refresh directly, no dialogs needed.

## How It Works

1. Define named presets in `oh-my-opencode-slim.jsonc` under the `presets`
   field, or create them interactively from the manager
2. **Save** writes the preset definition to the user config file. **Save &
   Apply** also selects the preset as the active one. Neither claims a live
   apply: both persist the file and *request* the live refresh (below); the
   running session is untouched either way
3. On v2 hosts a saved/applied preset requests the live refresh: the
   server-side watcher re-reads the config, resolves **only** the inference
   fields (`model`, `variant`, `temperature`, `options`) into per-agent
   runtime profiles, republishes the fallback chains (a `model` array's full
   chain, not just its head) in the same generation, and freezes the current
   profile — and that chain generation — for each **new child session**
   (dispatched subagents) before its first request. The sidebar's
   model/variant rows are rewritten by the same server-side projection, and
   the TUI sidebar re-reads its config-backed rows. The TUI only persists
   the file and requests this refresh — the refresh itself runs in the
   server process and its outcome is not observable from the TUI
4. Manual edits to the config file(s) trigger the same refresh (the plugin
   watches the user and project config candidates — `.json` and `.jsonc`,
   including files/directories created after startup, under any
   `OPENCODE_CONFIG_DIR`, XDG, or project `.opencode` location — debounced
   ~300 ms)
5. The current session is **not** touched — this is deliberate. Existing and
   resumed sessions keep the profiles captured when they were first seen, and
   every non-inference field (`prompt`, `tools`, `permission`, `skills`,
   `mcps`, `description`, `displayName`) stays frozen for the session
   lifetime. Hot-swapping the agent tree mid-conversation could truncate
   context (a new model may have a smaller window), drift prior assistant
   turns under a changed system prompt, leave running subagents referencing
   stale agent definitions, or shift tool/skill availability

The TUI reports `Saved … Live refresh requested` on success — it never claims
the refresh was applied. If the config file is malformed (invalid JSON,
schema rejection, read error), the refresh is rejected **before anything is
swapped**: the last-known-good profiles and sidebar stay in place and the
server logs the failure with its cause. A refresh request that fails in the
TUI process degrades to the actionable **reload OpenCode to apply**
fallback; if new child dispatches still use the old inference fields after a
malformed edit, fix the config and reload OpenCode. A rejected refresh never
swaps profiles, never rewrites the sidebar, and never claims success.

`/preset` writes the selected preset name to the user config file. It does not
create an in-memory agent override. On v1 hosts, **reload OpenCode** after
applying a preset. In both cases a running conversation keeps its existing
models.

## Editing inherited presets

At Level 2, select **Base preset** to choose one parent preset or **(none)**.
The manager prevents self-references and inheritance cycles. Inherited agents
are shown for context but are read-only. To change one, use **+ Add agent** to
create a local override, then edit it at Level 3.

Saving an inherited preset preserves its `extends` value and writes only its
local agent overrides; it does not flatten or copy inherited agents into the
child. Editing the base preset therefore affects its children after the next
live refresh (v2: new child dispatches pick the inference changes up once the
watcher refresh lands) or reload. A base preset with dependents cannot be
deleted until those children choose another base or clear inheritance.

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
      "explorer": { "model": "openai/gpt-6-luna" },
      "oracle": { "model": "anthropic/claude-sonnet-4-6" }
    },
    "powerful": {
      "orchestrator": { "model": "openai/gpt-6" },
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

On v2 hosts the live refresh hot-applies **only** these inference fields, and
only to **new child sessions** (captured before their first request) plus the
sidebar; every other preset field applies after a full OpenCode reload. A
malformed config keeps the last-known-good profiles and sidebar (the refresh
is rejected, not applied):

| Field | Description |
|-------|-------------|
| `model` | Model ID in `provider/model` format. Array form (fallback chains) is resolved to the first entry, and the full fallback chain is refreshed with it — new child sessions descend the refreshed chain, a child already registered keeps the chain generation it registered with. Removing a marketplace agent's override reverts new children to the package's own chain |
| `temperature` | Inference temperature (0-2) |
| `variant` | Model variant (e.g. `"thinking"`) |
| `options` | Provider-specific options (e.g. thinking budget) |

The `extends` field is resolved when the preset is applied. Presets support
one parent only; multi-parent inheritance is not supported.

Frozen for the session lifetime — new child dispatches do **not** receive
these until a full OpenCode reload: `prompt`, `tools`, `permission`,
`skills`, `mcps`, `description`, `displayName`.

## Startup Preset vs Runtime Switching

There are two ways to activate a preset:

| Method | How | Persists? |
|--------|-----|-----------|
| Config file | Set `"preset": "cheap"` in `oh-my-opencode-slim.jsonc` | Yes, across restarts |
| `/preset` TUI command | Open the manager and apply a preset (v2: or the sidebar's preset row, or `/preset <name>`) | Yes — writes to config file; v2 hosts request the live refresh (inference fields apply to new child sessions once the watcher refresh lands), v1 hosts need a reload |

The `/preset` TUI command writes the selected preset name to the config file,
so the switch persists across restarts. On v2 hosts the write also requests
the live refresh: once the server-side watcher refresh succeeds, new child
dispatches and the sidebar use the new inference fields, while the current
session continues uninterrupted with its existing models and frozen
prompt/tool surfaces. A malformed config leaves the last-known-good state in
place until it is fixed (and reloaded). On v1 hosts, **reload OpenCode** for
the new preset to take effect on the agent registry.

> See [Configuration](configuration.md) for the full preset option reference.
