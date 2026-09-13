## ADDED Requirements

### Requirement: Presets support an optional single parent declaration
The system SHALL keep preset objects without `$extends` valid and behaviorally unchanged. A preset MAY declare one reserved `$extends` metadata field, which MUST be either `null` or a non-empty preset name. Empty and whitespace-only `$extends` strings MUST be rejected as schema validation errors.

#### Scenario: Existing presets remain unchanged
- **WHEN** a preset object does not contain `$extends`
- **THEN** the system accepts it and applies it with its existing behavior

#### Scenario: A preset declares a valid parent or detachment
- **WHEN** a preset object's `$extends` value is a non-empty preset name or `null`
- **THEN** the system accepts the value as the preset's parent declaration

#### Scenario: A preset declares an empty parent name
- **WHEN** a preset object's `$extends` value is empty or contains only whitespace
- **THEN** schema validation rejects the preset and reports the value as a schema error rather than a graph-resolution error

### Requirement: Layered preset definitions merge parent metadata before inheritance resolution
When user and project configuration layers define the same preset, the system MUST merge those preset definitions using the existing layer precedence before resolving inheritance. An omitted higher-layer `$extends` MUST preserve the lower-layer parent, a higher-layer string MUST replace it, and a higher-layer `null` MUST detach it.

#### Scenario: An omitted higher-layer parent is preserved
- **WHEN** a lower layer defines `presets.child.$extends` as `base` and a higher layer defines `presets.child` without `$extends`
- **THEN** the merged `child` preset still extends `base`

#### Scenario: A higher-layer parent replaces the lower-layer parent
- **WHEN** a lower layer defines `presets.child.$extends` as `base` and a higher layer defines it as `alternate`
- **THEN** the merged `child` preset extends `alternate` instead of `base`

#### Scenario: A higher-layer null detaches the lower-layer parent
- **WHEN** a lower layer defines `presets.child.$extends` as `base` and a higher layer defines it as `null`
- **THEN** the merged `child` preset has no parent

V1 defines no general inherited-field deletion behavior; `$extends: null` is only the parent-detachment mechanism.

### Requirement: Effective preset configuration preserves existing deep-merge precedence
For a selected preset, the system MUST resolve the parent chain from the oldest ancestor to the immediate parent, then the selected child, and then merge root `agents` overrides last. The system MUST preserve existing deep-merge behavior: nested objects merge recursively, while arrays and primitive values are replaced by the higher-precedence value.

#### Scenario: A multi-level chain resolves oldest-first
- **WHEN** `child` extends `middle` and `middle` extends `base`
- **THEN** the effective configuration applies `base`, then `middle`, then `child`, followed by root `agents` overrides

#### Scenario: Nested objects merge across the chain
- **WHEN** an inherited preset supplies one property of a nested object and a child supplies another property of that object
- **THEN** the effective configuration contains both properties unless a higher-precedence value replaces the object

#### Scenario: Arrays and primitive values are replaced
- **WHEN** a child or root `agents` override supplies an array or primitive value for a field also supplied by an ancestor
- **THEN** the effective configuration uses the higher-precedence array or primitive value rather than combining it with the ancestor value

### Requirement: Parent-only presets remain selectable and effective
The system SHALL keep a valid preset available for selection when it is present as an inheritance target but is not otherwise defined in a higher-priority configuration layer. Selecting that parent-only preset MUST apply its own configuration and inherited ancestors.

#### Scenario: A parent-only preset is selected directly
- **WHEN** `base` exists in the merged preset set only as an inheritance target and the user selects `base`
- **THEN** the system accepts the selection and applies `base` with its effective inherited configuration

### Requirement: Every merged preset graph is validated eagerly
Before plugin startup, the system MUST validate the parent graph for every merged preset, including presets that are not selected or active. Any missing parent or inheritance cycle MUST prevent startup and the diagnostic MUST identify the missing parent reference or the cycle path.

#### Scenario: An inactive preset references a missing parent
- **WHEN** an unselected merged preset extends a preset name that does not exist
- **THEN** plugin startup fails with a diagnostic naming the missing parent reference

#### Scenario: An inactive preset participates in a cycle
- **WHEN** an unselected merged preset is part of an inheritance cycle
- **THEN** plugin startup fails with a diagnostic showing the cycle path

### Requirement: Inheritance graph failures are the only newly fatal validation errors
The system MUST treat missing-parent and cycle graph errors as newly fatal for the merged inheritance graph, while preserving existing handling for malformed JSON and other schema-invalid configuration. A schema-invalid `$extends` value MUST NOT be reported as a graph-resolution error.

#### Scenario: A missing parent fails startup as a graph error
- **WHEN** a valid preset declares a parent that is absent from the merged preset set
- **THEN** startup fails because of the missing-parent graph error

#### Scenario: Malformed JSON keeps existing handling
- **WHEN** a configuration file contains malformed JSON
- **THEN** the system handles the configuration using its existing malformed-JSON behavior rather than the new inheritance graph-failure behavior

#### Scenario: A schema-invalid preset keeps existing schema handling
- **WHEN** a preset contains a schema-invalid field, including an empty or whitespace-only `$extends`
- **THEN** the system handles it using its existing schema-validation behavior and does not classify it as a missing-parent or cycle error

### Requirement: The parent declaration remains metadata rather than an agent configuration
The system MUST NOT expose `$extends` as an agent, summary or count entry, alias, or runtime override when presets are loaded or applied through supported preset selection.

#### Scenario: A preset parent declaration is loaded
- **WHEN** a preset contains `$extends` alongside agent configuration
- **THEN** only the configured agents contribute agent registrations, summaries, counts, and aliases, and `$extends` contributes no runtime override

### Requirement: Supported preset surfaces reflect resolved inheritance
Startup and reload-based preset selection, disk-based preset switching validation, TUI editing and preservation, generated schema, and doctor validation MUST reflect the same `$extends` schema, effective inheritance, and graph-validation rules. V1 does not define behavior for dormant live runtime-preset switching.

#### Scenario: Startup or reload selection uses inherited values
- **WHEN** a preset is selected during startup or a supported reload and it extends another preset
- **THEN** the selected configuration includes the resolved inherited values with the defined precedence

#### Scenario: Disk switching validates inheritance before activation
- **WHEN** a disk-based preset switch targets a preset with a missing parent or cycle
- **THEN** validation rejects the switch with the corresponding graph diagnostic instead of activating it

#### Scenario: TUI editing preserves the parent declaration
- **WHEN** the TUI edits and saves a preset that contains `$extends`
- **THEN** the saved preset preserves the parent declaration and the TUI reflects the preset's effective inherited configuration

#### Scenario: TUI rejects a save that would create an invalid graph
- **WHEN** a TUI save or overwrite would introduce a missing parent or inheritance cycle after merging the candidate user configuration with the project layer
- **THEN** the system rejects the mutation with the graph diagnostic and leaves the on-disk configuration unchanged

#### Scenario: TUI rejects deletion of a referenced parent
- **WHEN** a TUI delete would remove a preset that an effective child still names as its parent
- **THEN** the system rejects the deletion as a missing-parent graph error and leaves the on-disk configuration unchanged

#### Scenario: Generated schema describes the parent declaration
- **WHEN** the generated configuration schema is inspected for preset objects
- **THEN** it describes `$extends` as an optional reserved value accepting a non-empty preset name or `null`, and rejects empty or whitespace-only names

#### Scenario: Doctor validation checks the merged inheritance graph
- **WHEN** doctor validation examines configured presets
- **THEN** it applies schema validation and eager missing-parent and cycle checks to the merged preset graph

### Requirement: Inline prompt fields inherit without inheriting parent prompt directories
The system SHALL include inline prompt fields from resolved ancestors in a selected preset's effective configuration, but MUST NOT inherit prompt directories declared by a parent preset.

#### Scenario: An inline parent prompt is inherited
- **WHEN** a parent preset defines an inline prompt field and its child does not replace that field
- **THEN** the child's effective configuration includes the parent's inline prompt field

#### Scenario: A parent prompt directory is not inherited
- **WHEN** a parent preset defines a prompt directory and a child preset extends it
- **THEN** the child's effective configuration does not gain that parent prompt directory
