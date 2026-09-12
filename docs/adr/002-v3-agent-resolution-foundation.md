# ADR 002: V3 agent resolution foundation

## Status

Accepted and implemented for Deepwork Phase 1.

## Decision

The plugin builds one runtime-only `ResolvedAgentRegistry`. Agent SDK
registration, model fallback chains, routing guidance, skill visibility, MCP
selection, TUI model state, and diagnostics all consume that snapshot. The
registry is rebuilt on plugin startup/reload; it is never hot-swapped during a
conversation.

The supported specialist role catalog is explicit: `explorer`, `librarian`,
`oracle`, `designer`, `fixer`, and `observer`. Their reusable
`RoleDefinition`s are the only built-in baselines available to marketplace
agents. `orchestrator`, `council`, and `councillor` remain special agents and
cannot be marketplace extension targets.

Presets are structured objects:

```json
{
  "agents": {
    "explorer": { "model": "provider/model" }
  },
  "marketplace": {
    "agents": ["community/example"],
  }
}
```

Activation arrays are optional so omitted and explicit empty values remain
distinguishable during typed merges. Package IDs are trimmed and unique. The
runtime resolves installed agents from the local store for the effective active
preset, preflights declared skills/MCPs, and applies them into the one
`ResolvedAgentRegistry`. Package state remains outside `PluginConfigSchema`.

Prompt resolution is a pure ordered pipeline: optional built-in baseline,
package append/replace, owner replacement, owner append, then host-supported
fields. Mandatory plugin suffixes are
added last, so replacements cannot remove workflow or role-policy gates.
Inline replacement wins over a replacement file, and append files remain
supported. Inputs are construction-time deterministic and do not contain
volatile request data.

Typed alias-aware merges are used for agent records and structured presets.
Scalars and arrays replace; provider option objects merge; model inheritance is
an explicit directive that clears a lower model, while an explicit model clears
lower inheritance. The loader preserves structural presets and the resolved
registry combines the active preset with root/host layers exactly once. User
configuration remains editable and higher precedence than package content.
Task controls are editable defaults; only documented plugin gates are applied
after host projection.

Declared skills and MCPs are preflighted from built-in capabilities and on-disk
host configuration. Missing dependencies disable an agent for that session.

## Resolution truth table

| Surface | Lower layer | Higher layer | Merge rule | Phase 1 result |
| --- | --- | --- | --- | --- |
| Role baseline | `RoleDefinition` | user agent override | typed field merge | Implemented |
| Prompt | baseline | replacement file/inline prompt | inline > file > baseline | Implemented |
| Prompt append | selected prompt | append file | append after selected prompt | Implemented |
| Prompt gates | all editable prompt layers | plugin suffix | append last, immutable | Implemented |
| Model | baseline/active preset | root/host override | explicit model wins; inheritance is directive | Implemented |
| Model array | lower chain | higher chain | replace array; first entry is startup model | Implemented |
| Options | lower object | higher object | shallow typed object merge | Implemented |
| Skills | role defaults | explicit agent skills | explicit list replaces defaults; disabled skills deny | Implemented |
| MCPs | role defaults | explicit agent MCPs | explicit list replaces defaults; disabled MCPs are unavailable | Implemented |
| Permissions | defaults | user rules | editable rules first, immutable gates after host projection | Implemented |
| Routing | resolved enabled agents | none | canonical deterministic name ordering | Implemented |
| Preset | user preset | project preset | structural merge by name; active agent layers merge once in registry | Implemented |
| Marketplace agent | optional builtin baseline | package config | standalone or one-builtin extension | Implemented |
| Dependency preflight | declared skills/MCPs | host availability | missing dependency disables agent | Implemented |
| Package state | plugin config | lock/store | separate parsed state, exact versions, offline startup | Implemented |
