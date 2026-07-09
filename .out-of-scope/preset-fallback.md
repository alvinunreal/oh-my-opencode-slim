# Preset Fallback & Preset-Scoped Mode

This project does not support preset-to-preset fallback or preset-scoped mode.

## Why this is out of scope

Model-level fallback already exists in the plugin: when an agent's `model` is
configured as an array, the entries form a fallback chain resolved at runtime by
`ForegroundFallbackManager` (abort the failed session, re-prompt with the next
untried model). Subagents not listed in the active preset also inherit the
preset's primary model. So the runtime "if my model is unavailable, try another"
surface is already covered.

What was requested goes further and is a different shape:

- **Preset-to-preset fallback** — a preset declaring it falls back to another
  preset (e.g. `PresetSchema` gaining a `fallback`/`extends` field). This needs
  schema changes plus resolution wiring in the preset manager and config hook,
  and raises questions about which agents/settings the fallback preset supplies.
- **Preset-scoped mode** — restricting a preset to certain agents, directories,
  tasks, or conversation modes (a `scope` field on `PresetSchema`). This is a
  meaningful design surface with no current implementation (zero matches in the
  codebase) and no agreed semantics.

The maintainer chose not to take on that design/implementation as `wontfix`
(issue #638). If the need recurs with a concrete design, revisit.

## Prior requests

- #638 — "Support preset fallback and document preset-scoped mode"
