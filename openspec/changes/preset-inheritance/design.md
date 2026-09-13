## Context

Preset definitions are currently maps of agent names to
`AgentOverrideConfig` values. `src/config/loader.ts` parses user and project
files independently, structurally merges them with `mergePluginConfigs()` and
`deepMerge()`, then applies the selected preset to root `agents`. Invalid JSON
and schema results are converted to warnings and an empty-config fallback.

The same loaded configuration is consumed in different ways. Startup passes
the selected agent map through `src/agents/index.ts` and `src/index.ts`, while
`src/tui-preset.ts` and `src/tools/preset-switch.ts` read and write raw preset
definitions for on-disk CRUD. `src/cli/doctor.ts` performs its own per-file
schema checks before checking the merged configuration. Prompt files are
resolved by `loadAgentPrompt()` from the active preset directory and project
or user prompt roots.

Inheritance therefore needs a small boundary between raw preset definitions
and resolved runtime overrides. The raw form must retain `$extends` for
editing and persistence, while runtime maps must contain only agent override
entries. Resolution must happen after the user/project merge so a project
`$extends: null` can detach a user-layer parent.

## Goals / Non-Goals

**Goals:**

- Support one optional `$extends` parent per preset, accepting a non-empty
  preset-name string or `null`.
- Resolve and validate every effective preset after the user/project merge and
  before active preset selection.
- Preserve the existing parent < child < root `agents` precedence and
  `deepMerge()` behavior: nested objects merge, while arrays and primitives
  replace.
- Keep raw `$extends` metadata available to TUI CRUD while exposing
  metadata-free resolved preset maps to runtime consumers.
- Fail startup with a dedicated semantic error for missing parents and cycles,
  while leaving malformed JSON/schema fallback behavior unchanged.
- Keep parent-only inherited presets valid and inherit inline prompt fields.
- Cover startup/reload-based disk switching, TUI validation and switching, the
  generated schema, and doctor validation.

**Non-Goals:**

- Supporting multiple parents, mixins, or general inherited-field deletion.
- Inheriting parent prompt directories; prompt-file lookup remains scoped to
  the active preset and existing project/user roots.
- Adding or reactivating dormant live runtime-preset switching through
  `src/config/runtime-preset.ts`.
- Changing the behavior of existing presets that do not use `$extends`.

## Decisions

### Decision: Keep raw definitions and add one derived runtime view

The schema-facing preset value will retain the reserved `$extends` member and
the existing agent override entries. The loaded configuration will also carry
a runtime-only map such as `resolvedPresets: Record<string, Preset>`, where
each `Preset` contains only agent overrides. The derived map is not serialized
and is not part of the user-authored JSON schema.

`config.agents` will continue to be the metadata-free effective map for the
selected preset after root-agent merging. Runtime code that needs a preset by
name, including active-model lookup, orchestrator-model stripping, and preset
summaries, will use the derived map. TUI CRUD will use the raw map and preserve
`$extends` when reading, editing, saving, or deleting presets. Its agent lists,
counts, aliases, and descriptions will exclude the reserved member.

This extends the existing loader result rather than introducing a second
loader or requiring every consumer to strip metadata independently.

**Alternatives considered:**

- Replacing `config.presets` with resolved maps was rejected because TUI edits
  would lose the parent declaration and could not preserve `$extends: null`.
- Keeping only raw maps and filtering `$extends` at every call site was
  rejected because it duplicates the boundary and risks metadata leaking into
  agent discovery, summaries, or runtime switching.
- Adding a separate TUI-specific loader was rejected because it would create
  two parsing and merge paths with different validation behavior.

### Decision: Resolve only after layered structural merge

`mergePluginConfigs()` will continue to perform the existing raw structural
merge. Once the effective user/project configuration exists, a single config
resolver will traverse the complete raw preset graph, build the derived
metadata-free map, and validate every preset before `config.preset` is applied
to root `agents`.

Because the project layer is the override in `deepMerge()`, a project
`$extends: null` replaces a user-layer parent marker. If the project layer
does not mention `$extends`, the user-layer marker remains. No separate
resolution of the user and project graphs is performed.

**Alternatives considered:**

- Resolving each file before merging was rejected because a project layer could
  not reliably detach or replace a parent inherited from the user layer.
- Resolving only the selected preset was rejected because the contract
  requires eager validation of the whole effective graph, including unused and
  parent-only presets.

### Decision: Separate schema errors from graph errors

The schema will validate `$extends` as optional, nullable, and non-empty after
trimming. Empty or whitespace-only values remain ordinary schema errors and
therefore follow the current invalid-schema warning/fallback path. A preset
name that is structurally valid but missing, or a graph that cycles, is
validated only after the complete layered merge.

The resolver will throw a dedicated semantic inheritance error identifying the
kind of graph failure and the relevant preset names. `loadPluginConfig()` will
not convert that error into a warning or an empty config. The main startup
path in `src/index.ts` already logs and rethrows initialization failures, so a
graph error prevents plugin startup for the whole effective configuration.

Non-startup callers will handle the same error explicitly rather than silently
using raw presets: doctor will report a graph-level validation failure and
return a failing result, while TUI config reads and preset switching will
surface an invalid-inheritance message and avoid applying changes. Existing
missing-active-preset warnings and malformed-file handling remain separate.

**Alternatives considered:**

- Treating missing parents and cycles as schema errors was rejected because
  parent existence and cycle membership are properties of the merged graph,
  not of one file.
- Reusing the existing warning/fallback path was rejected because it could
  silently discard a user-selected or inherited configuration despite the
  feature's explicit fatal graph contract.

### Decision: Resolve parent, child, then root agents with existing merge rules

For each preset, the resolver will recursively resolve its one parent, remove
the raw `$extends` metadata from the merge inputs, and apply `deepMerge(parent,
child)`. A parent-only child therefore resolves to the parent's agent map. The
selected resolved preset is then merged into root `config.agents` as it is
today, with root agents taking precedence.

The resolver will track presets currently being visited so a cycle is reported
as a graph error, and it will reuse completed resolutions for shared parents.
It will validate all preset names before returning any runtime view, so no
partial map is exposed after a graph failure. `$extends: null` means the child
has no parent; it does not delete inherited fields from any other source.

### Decision: Keep prompt-file inheritance scoped to the active preset

Inline `prompt` and `orchestratorPrompt` values are ordinary agent override
fields, so they participate in the parent-to-child `deepMerge()` and are
available through the resolved `config.agents` map. `loadAgentPrompt()` will
continue to receive only the active preset name. It will not walk parent
preset directories or combine files from parent and child directories.

This preserves the current project/user prompt lookup order and makes the v1
boundary explicit: inline configuration inherits, filesystem prompt assets do
not.

### Decision: Route active disk switching through resolved presets, not live state

`switchPresetOnDisk()` will persist the selected raw preset name as it does
today, but its agent updates, empty-preset check, and summaries will be built
from the resolved metadata-free entry. This makes parent-only presets usable
and prevents `$extends` from becoming an agent update or summary row. Raw
write/delete operations will retain the marker so TUI CRUD does not flatten or
discard inheritance declarations.

The next startup or reload will re-run the loader, resolve the full graph, and
apply the selected child to root agents. The module-level live state in
`src/config/runtime-preset.ts` remains outside the feature's switching
semantics; any existing runtime map reads must use the derived view only to
maintain the metadata boundary, without adding dormant live inheritance
switching.

Before TUI save, overwrite, or delete persistence, the mutation path will build
the candidate user configuration, merge it with the current project layer, and
run the shared graph resolver. A mutation that would introduce a missing parent
or cycle is rejected with the graph diagnostic before any write occurs, leaving
the on-disk configuration unchanged. This applies equally to deleting a preset
that another effective preset references.

### Decision: Make doctor use the same post-merge resolver

After `src/cli/doctor.ts` confirms the individual user and project files are
valid, it will structurally merge their raw configurations and invoke the same
graph resolver used by the loader. A missing parent or cycle is reported at the
merged-config level, because it may span both files, and causes doctor to
return a non-zero result. Per-file malformed JSON and schema diagnostics keep
their current result kinds and behavior.

The generated JSON schema remains derived from `PluginConfigSchema` through
`scripts/generate-schema.ts`; implementation will regenerate it after adding
the `$extends` shape rather than maintaining a hand-written schema branch.

## Risks / Trade-offs

- **A dormant or unselected invalid preset can now stop startup** → Mitigation:
  validate and report every preset clearly, as required by whole-graph eager
  validation; doctor provides a pre-startup diagnostic path.
- **Raw and resolved views could drift if a consumer chooses the wrong one** →
  Mitigation: keep the raw/resolved distinction explicit in the loader result,
  route runtime summaries and agent construction through the resolved view, and
  keep raw access limited to persistence-oriented TUI operations.
- **Layered `$extends: null` behavior may be surprising** → Mitigation:
  document that null replaces the lower-priority parent marker and does not
  perform general field deletion.
- **Inherited inline prompts and child-only prompt directories can diverge** →
  Mitigation: retain the existing active-preset prompt lookup and document that
  only inline prompt fields inherit in v1.
- **New fatal errors need to be distinguishable from existing fallback errors**
  → Mitigation: use a dedicated semantic error and preserve the current JSON,
  schema, and read-error warning paths unchanged.
- **A raw TUI mutation could make the next startup fail** → Mitigation: validate
  the fully merged candidate graph before every save, overwrite, or delete and
  persist only after validation succeeds.

## Migration Plan

1. Extend the preset schema and inferred raw types with the reserved
   `$extends` value, then regenerate the published JSON schema.
2. Add the post-merge graph resolver and the runtime-only resolved preset view;
   invoke it before active preset selection in `loadPluginConfig()`.
3. Route agent construction, startup model selection, orchestrator-model
   handling, disk switching, and summaries through metadata-free resolved
   presets while preserving raw TUI persistence.
4. Update TUI error handling and raw editing so inheritance metadata is retained
   but never treated as an agent. Update doctor to report merged graph errors.
5. Add focused validation for schema-vs-graph errors, layered detachment,
   precedence, parent-only presets, metadata isolation, prompt boundaries, and
   startup/reload switching.

There is no data migration for existing configurations. Configurations without
`$extends` continue to resolve as before. A graph failure is corrected by
fixing the parent name/cycle or removing the `$extends` declaration; rollback
does not require changing persisted configuration fields beyond removing the
new marker.

## Open Questions

- None for the fixed v1 contract.
