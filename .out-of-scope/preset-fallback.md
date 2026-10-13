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

- **Preset-to-preset fallback** — a preset declaring that on failure it falls
  back to another preset's lineup (a `fallback` field on `PresetSchema`). This
  needs schema changes plus resolution wiring in the preset manager and config
  hook, and raises questions about which agents/settings the fallback preset
  supplies. Preset *inheritance* is a different feature and already exists:
  `presets.<name>.extends` resolves a parent preset before the child
  (`src/config/presets.ts`, documented under "Preset inheritance" in
  `docs/configuration.md`). The missing piece is only runtime
  fallback-on-failure semantics.
- **Preset-scoped mode** — the #638 close records "restricting a preset to
  certain agents/directories/tasks" as out of scope: no implementation exists
  (zero matches in the codebase) and no agreed semantics. The issue body's
  concrete ask, `presetName:agentName` keyed chains, is substantively covered
  already — a preset agent entry with an array `model` configures that agent's
  runtime fallback chain while the preset is active — only the shorthand key
  syntax is missing.

Issue #638 was closed as `wontfix` during triage rather than taking on that
design/implementation. If the need recurs with a concrete design, revisit.

## Prior requests

- #638 — "Support preset fallback and document preset-scoped model chains"
