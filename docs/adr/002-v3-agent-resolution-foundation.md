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
`RoleDefinition`s are the only role baselines available for future derived
agents and profiles. `orchestrator`, `council`, and `councillor` remain special
agents and are not profile targets.

Presets are structured objects:

```json
{
  "agents": {
    "explorer": { "model": "provider/model" }
  },
  "marketplace": {
    "agents": ["community/example"],
    "profiles": { "oracle": "community/oracle-profile" }
  }
}
```

Activation arrays are optional so omitted and explicit empty values remain
distinguishable during typed merges. Package IDs are trimmed and unique; profile
targets are limited to supported specialist roles and `null` is a removal
tombstone. Phase 3 resolves installed packages from the local store for the
effective active preset, preflights required skills/MCPs, and applies derived
agents and specialist profiles into the one `ResolvedAgentRegistry`. Package
state remains outside `PluginConfigSchema`.

Prompt resolution is a pure ordered pipeline: built-in baseline, package
append/replace (reserved for later phases), preset override, root override,
host-supported fields, then user append files. Mandatory plugin suffixes are
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

Required dependencies for future packages will be preflighted from built-in
capabilities and on-disk host configuration. Missing required dependencies
disable a package for that session; optional dependencies remain unavailable.
Those package behaviors belong to later phases, not this ADR's implementation.

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
| Marketplace agent | role baseline | package config | append-only role derivation | Implemented |
| Marketplace profile | role baseline | one selected profile | one profile per explicit supported role; null is tombstone | Implemented |
| Dependency preflight | package requirements | capabilities | required missing dependency disables package | Implemented |
| Package state | plugin config | lock/store | separate parsed state, exact versions, offline startup | Implemented |
