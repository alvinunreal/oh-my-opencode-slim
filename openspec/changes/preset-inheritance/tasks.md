## 1. Preset Schema and Resolution Core

- [x] 1.1 **Owner: @fixer** — Extend the preset schema and inferred raw
  configuration types with reserved `$extends` metadata accepting a trimmed,
  non-empty preset name or `null`, while preserving existing preset objects and
  the current schema-error fallback path.
- [x] 1.2 **Owner: @fixer** — Implement metadata-free single-parent preset
  resolution over the fully merged user/project graph, including layered null
  detachment, oldest-parent-first deep merging, memoized traversal, and a
  dedicated fatal error for missing parents and cycle paths.
- [x] 1.3 **Owner: @fixer** — Integrate eager whole-graph resolution into
  `loadPluginConfig()` before active preset selection, expose the smallest
  durable raw-definition/resolved-runtime boundary, and preserve root
  `agents` as the final precedence layer.
- [x] 1.4 **Owner: @fixer** — Add focused behavior tests for schema acceptance,
  layered parent replacement and detachment, chain precedence, parent-only
  presets, metadata isolation, inactive missing parents, and cycles. Keep the
  new inheritance behavior in a cohesive test owner rather than materially
  enlarging an oversized existing test file.
- [x] 1.5 **Owner: @oracle — Wave 1 review gate** — Review the complete Wave 1
  schema, resolver, loader integration, and focused tests as one coherent wave.
  Oracle proposes an action and the caller reconciles all findings; authoritative
  `REVIEW_ACTION=PATCH` returns implementation to Wave 1, and Wave 2 begins only
  after the caller records authoritative `REVIEW_ACTION=PASS`.

## 2. Supported Preset Consumers

- [x] 2.1 **Owner: @fixer** — Route startup agent/model consumers and supported
  reload-based preset behavior through resolved metadata-free presets without
  activating or expanding dormant live runtime-preset switching.
- [x] 2.2 **Owner: @fixer** — Update disk preset switching and TUI preset CRUD,
  summaries, counts, aliases, validation, and parent-only selection so raw
  `$extends` metadata is preserved for persistence but never treated as an
  agent. Validate the fully merged candidate graph before every save,
  overwrite, or delete and leave the on-disk config unchanged when the mutation
  would introduce a missing parent or cycle.
- [x] 2.3 **Owner: @fixer** — Make doctor and other supported non-startup config
  callers use the shared post-merge graph validation and surface dedicated
  missing-parent or cycle diagnostics without swallowing them as ordinary
  file/schema fallbacks.
- [x] 2.4 **Owner: @fixer** — Add focused consumer tests proving inherited
  startup/reload values, switch rejection for invalid graphs, TUI metadata
  preservation, unchanged files after rejected save/overwrite/delete mutations,
  referenced-parent delete rejection, doctor failure reporting, and the
  boundary that inline prompt fields inherit while parent preset prompt
  directories do not.
- [x] 2.5 **Owner: @oracle — Wave 2 review gate** — Review the complete Wave 2
  consumer integration and focused tests as one coherent wave. Oracle proposes
  an action and the caller reconciles all findings; authoritative
  `REVIEW_ACTION=PATCH` returns implementation to Wave 2, and Wave 3 begins only
  after the caller records authoritative `REVIEW_ACTION=PASS`.

## 3. Published Contract and Verification

- [x] 3.1 **Owner: @junior-engineer** — Regenerate
  `oh-my-opencode-slim.schema.json` from the source schema and verify it exposes
  `$extends` as an optional non-empty preset name or `null` without weakening
  validation of ordinary agent entries.
- [x] 3.2 **Owner: @junior-engineer** — Update `README.md` and the relevant
  configuration, project-local customization, and preset-switching docs with
  syntax, merge precedence, null detachment, fatal graph diagnostics,
  parent-only presets, reload behavior, and the prompt-directory/live-switching
  exclusions.
- [x] 3.3 **Owner: Orchestrator** — Run the focused inheritance and preset
  consumer checks, then the repository-required `bun run check:ci`,
  `bun run typecheck`, and `bun test`; inspect failures and generated-artifact
  drift before declaring the change implementation-ready.
- [x] 3.4 **Owner: @oracle — Wave 3 review gate** — Review the complete Wave 3
  published schema, documentation, and verification evidence as one coherent
  wave. Oracle proposes an action and the caller reconciles all findings;
  authoritative `REVIEW_ACTION=PATCH` returns implementation to Wave 3, and the
  change advances only after the caller records authoritative
  `REVIEW_ACTION=PASS`.
