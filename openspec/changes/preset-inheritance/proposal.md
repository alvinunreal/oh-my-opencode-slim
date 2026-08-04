## Why

Preset configurations currently duplicate fields when variants share common agent settings, making layered user/project configs harder to maintain. A single explicit parent relationship would reduce duplication while preserving existing preset behavior and deep-merge semantics.

## What Changes

- Add an optional reserved inline `$extends` field to each preset. It accepts one preset name or `null`; `null` detaches a parent inherited from a lower-priority config layer.
- Resolve inheritance over the fully merged user/project preset graph. Merge precedence is parent < child < root `agents`, while preserving existing deep-merge behavior. Inline prompt fields inherit, but parent preset prompt directories do not in v1.
- Validate every preset eagerly after merge. Missing parents and cycles invalidate the whole merged config and fail plugin startup. Existing malformed JSON/schema fallback behavior remains unchanged.
- Apply inheritance to active startup/reload-based disk preset switching, including the preset switching, TUI, and doctor validation surfaces. Dormant live runtime-preset switching is out of scope.
- Do not add general inherited-field deletion; `$extends: null` is the only detachment mechanism.
- Keep existing preset configurations without `$extends` valid.

## Capabilities

### New Capabilities

- `preset-inheritance`: Support single-parent inheritance for presets across layered configuration, with deterministic deep-merge precedence and eager graph validation.

### Modified Capabilities

## Impact

- Affects the config schema and loader, preset switching, TUI and doctor validation, generated schema, and configuration documentation.
- Existing presets remain compatible. The only newly breaking behavior is that configurations adopting `$extends` with a missing parent or cycle fail plugin startup because the merged inheritance graph is invalid.
