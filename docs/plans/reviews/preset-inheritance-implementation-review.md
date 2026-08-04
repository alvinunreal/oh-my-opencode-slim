# Preset Inheritance Implementation Review

## Ordered Owner Mapping

- Wave 1: `W1-A`, tasks `1.1-1.4`, owner `@fixer`; schema, resolver,
  loader integration, and focused core tests.
- Wave 2: `W2-A`, tasks `2.1-2.4`, owner `@fixer`; supported runtime,
  disk-switching, TUI, doctor, and focused consumer tests.
- Wave 3: `W3-A`, tasks `3.1-3.2`, owner `@junior-engineer`;
  generated schema and documentation. `W3-B`, task `3.3`, owner
  `Orchestrator`; repository verification.

## Round 1 - Implementation Assignments

**Wave:** 1 - Preset Schema and Resolution Core  
**Final gate reserved:** `1.5` - `@oracle` Wave 1 review gate

### W1-A - @fixer

- **Tasks:** `1.1`, `1.2`, `1.3`, `1.4`
- **Responsibility:** Implement the raw preset schema, metadata-free graph
  resolver, eager post-merge loader integration, and focused behavior tests.
- **Files/topics:** `src/config/schema.ts`, `src/config/loader.ts`, the smallest
  required config exports/types, and a cohesive inheritance-focused test owner.
- **Required evidence:** Recorded RED failures for missing behavior, focused GREEN
  test results, and type/lint checks scoped to touched files where available.
- **Status:** Dispatched.

### W1-A Evidence - @fixer

- **Files changed:** `src/config/schema.ts`, `src/config/loader.ts`,
  `src/config/index.ts`, and the cohesive test owner
  `src/config/preset-inheritance.test.ts`.
- **RED:** `bun test src/config/preset-inheritance.test.ts` before production
  changes produced 1 passing fallback test and 5 expected failures covering the
  missing `$extends` schema, inheritance resolution, layered parent behavior,
  inactive missing parents, and cycles.
- **GREEN:** `bun test src/config/preset-inheritance.test.ts` produced 6 pass,
  0 fail, and 25 assertions after implementation.
- **Scoped validation:**
  `env -u OH_MY_OPENCODE_SLIM_PRESET bun test src/config/preset-inheritance.test.ts src/config/loader.test.ts src/config/schema.test.ts src/config/project-local-customization.test.ts`
  produced 103 pass and 0 fail; scoped Biome checks passed for the four changed
  source/test files; scoped strict TypeScript checking passed for the config
  schema, loader, and index exports.
- **Caveats:** Repository-wide checks were intentionally not run for this wave.
  The focused regression command unsets the ambient `OH_MY_OPENCODE_SLIM_PRESET`
  value because existing loader tests expect that variable to be absent.

## Round 1 - Oracle Review

**Final gate consumed:** Task `1.5` — **Owner: @oracle — Wave 1 review gate** — Review the complete Wave 1 schema, resolver, loader integration, and focused tests as one coherent wave.

**Assignment mapping reviewed:**
- `W1-A`, tasks `1.1–1.4`, owner `@fixer` — schema, metadata-free resolver, eager loader integration, and focused behavior tests.
- Task `1.5`, owner `@oracle` — final Wave 1 review gate.
- Reviewed production changes in `src/config/schema.ts`, `src/config/loader.ts`, and `src/config/index.ts`, plus `src/config/preset-inheritance.test.ts`.

### P0

None.

### P1

1. **Missing parents named after inherited `Object.prototype` properties are accepted instead of failing startup — `src/config/loader.ts:376-383`.**
   - The resolver tests existence with `if (!preset)` after `rawPresets[name]`. Names such as `toString`, `constructor`, `hasOwnProperty`, or `__proto__` resolve through the object prototype even when no preset owns that name.
   - Confirmed independently: a child extending absent `toString` resolves successfully and produces synthetic `toString` and `child` entries instead of throwing `PRESET_INHERITANCE_MISSING_PARENT`.
   - This directly violates eager whole-graph validation and permits an invalid inactive graph to pass startup.
   - Check ownership with `Object.hasOwn(rawPresets, name)` before indexing. Prefer a prototype-free resolved lookup map—or equivalent own-property checks—so subsequent preset-name lookups have the same exact-key semantics. Add a focused regression using at least one prototype property name.

### P2

1. **Several explicit core scenarios lack mutation-sensitive coverage — `src/config/preset-inheritance.test.ts:66-156`.**
   - The layered test covers parent replacement and null detachment, but not preservation when the higher layer omits `$extends`.
   - The test observes the base entry in `resolvedPresets`, but does not directly select a parent that exists only in the lower layer and prove its effective configuration is applied.
   - Chain coverage proves nested-object and primitive precedence but not array replacement across inheritance.
   - The current implementation appears correct for these cases through `deepMerge`; these are nonblocking coverage gaps, not demonstrated production failures.

### P3

None.

**Verification:** The focused inheritance suite passes with 6 tests and 25 assertions. Repository-wide `bun run typecheck` currently reports raw-preset union errors in existing consumers such as `src/index.ts`, `src/tools/preset-switch.ts`, and `src/tui-preset.ts`; those call-site migrations belong to the explicitly assigned Wave 2 consumer work and are not scored as additional Wave 1 defects.

**Gate action:** Patch Wave 1 to enforce own-property graph membership and add the corresponding regression before advancing.

CONSENSUS_STATUS=NEEDS_REVISION

## Round 2 - Implementation Assignments

**Wave:** 1 - Preset Schema and Resolution Core  
**Final gate reused:** `1.5` - `@oracle` Wave 1 review gate

### W1-A Revision - @fixer

- **Tasks:** `1.2`, `1.4`
- **Blocking finding:** P1 prototype-chain preset names bypass exact missing-parent
  membership validation.
- **Responsibility:** Add a focused failing regression, enforce own-key graph
  membership throughout resolution, and preserve all prior Wave 1 behavior.
- **Files/topics:** `src/config/loader.ts` and
  `src/config/preset-inheritance.test.ts` only unless a minimal supporting change
  is required.
- **Required evidence:** Expected RED failure, focused GREEN result, and prior
  Wave 1 regression command.
- **Status:** Dispatched.

### W1-A Revision Evidence - @fixer

- **RED:** `bun test src/config/preset-inheritance.test.ts` after adding the
  `toString` missing-parent regression and before the loader fix produced 6
  passing tests, 1 failing test, and 26 assertions; the new test observed no
  thrown error.
- **GREEN:** `bun test src/config/preset-inheritance.test.ts` after the loader
  fix produced 7 passing tests, 0 failing tests, and 28 assertions.
- **Regression:** `env -u OH_MY_OPENCODE_SLIM_PRESET bun test
  src/config/preset-inheritance.test.ts src/config/loader.test.ts
  src/config/schema.test.ts src/config/project-local-customization.test.ts`
  completed successfully; output recorded 104 passing tests and 0 failures.

## Round 2 - Oracle Review

**Final gate consumed:** Task `1.5` — **Owner: @oracle — Wave 1 review gate** — Review the complete updated Wave 1 schema, resolver, loader integration, and focused tests as one coherent wave. This reuses the existing task `1.5`; no replacement gate was created.

**Complete W1-A mapping reviewed:**

- Task `1.1`, owner `@fixer` — `$extends` schema, trimming/null validation, and raw/resolved preset types in `src/config/schema.ts`.
- Task `1.2`, owner `@fixer` — metadata-free, memoized single-parent resolution and fatal graph errors in `src/config/loader.ts`.
- Task `1.3`, owner `@fixer` — eager post-merge resolution, `resolvedPresets`, selected-preset integration, root-agent precedence, and exports in `src/config/loader.ts` and `src/config/index.ts`.
- Task `1.4`, owner `@fixer` — focused behavior coverage in `src/config/preset-inheritance.test.ts`.
- W1-A revision, tasks `1.2` and `1.4`, owner `@fixer` — exact own-key membership and the `toString` missing-parent regression.
- Task `1.5`, owner `@oracle` — this final Wave 1 review gate.

### Prior P1 disposition

The prior P1 is fully fixed. `resolvePresetInheritance()` now checks raw graph membership with `Object.hasOwn()` at `src/config/loader.ts:375`, and active resolved-preset selection uses the same exact-key semantics at `src/config/loader.ts:453-457`. The new `toString` regression at `src/config/preset-inheritance.test.ts:181-200` is mutation-sensitive and passes.

### P0

None.

### P1

1. **An authored `__proto__` preset is silently dropped before graph resolution — `src/config/schema.ts:392`.**
   - `PluginConfigSchema` accepts the input without a schema warning, but Zod’s ordinary-object record construction omits an own `__proto__` preset key.
   - Independently reproduced with a JSON configuration defining both `presets.__proto__` and `child.$extends = "__proto__"`: the parsed preset keys contained only `child`, after which resolution incorrectly threw `PRESET_INHERITANCE_MISSING_PARENT`.
   - This violates the current contract permitting any trimmed, non-empty preset name and causes a defined parent to be diagnosed as absent.
   - Preserve exact own keys through the schema boundary—prefer a bounded own-key/prototype-free representation rather than additional generic graph machinery—and add a focused regression for a defined `__proto__` parent. Rejecting that name would require an explicit OpenSpec contract change.

### P2

1. **Some explicit task 1.4 scenarios still lack direct mutation-sensitive coverage — `src/config/preset-inheritance.test.ts:66-156`.**
   - Higher-layer omission preserving a lower-layer `$extends` remains untested.
   - Direct selection of a parent existing only in the lower layer remains untested.
   - Array replacement across the inheritance chain remains untested.
   - Existing `deepMerge()` behavior appears correct for these cases; these are nonblocking coverage gaps rather than demonstrated production failures.

### P3

None.

### Verification

- Re-ran the complete Wave 1 focused regression: `104 pass`, `0 fail`, `217` expectation calls.
- Confirmed `git diff --check` is clean.
- Adversarial diagnostics confirmed absent `toString`, `constructor`, `hasOwnProperty`, and `__proto__` parents now fail correctly; defined prototype-property parents work except for the schema-dropped `__proto__` case.
- Repository type checking still reports the previously documented raw-preset consumer errors in Wave 2-owned surfaces. Those staged migrations are not rescored as Wave 1 findings.

**Gate action:** `REVIEW_ACTION=PATCH`. Return W1-A to `@fixer` for the remaining P1 before Wave 2 begins.

CONSENSUS_STATUS=NEEDS_REVISION

## Round 3 - Implementation Assignments

**Wave:** 1 - Preset Schema and Resolution Core  
**Final gate reused:** `1.5` - `@oracle` Wave 1 review gate

### W1-A Schema-Boundary Revision - @fixer

- **Tasks:** `1.1`, `1.4`
- **Blocking finding:** P1 schema parsing silently drops an authored own
  `__proto__` preset key before graph resolution.
- **Responsibility:** Add a focused failing defined-parent regression, preserve
  exact own keys through the bounded preset schema boundary, and retain ordinary
  schema fallback behavior.
- **Files/topics:** `src/config/schema.ts`,
  `src/config/preset-inheritance.test.ts`, and only the smallest necessary loader
  support.
- **Required evidence:** Expected RED failure, focused GREEN result, and the full
  Wave 1 regression command.
- **Status:** Dispatched.

### W1-A Schema-Boundary Revision Evidence - @fixer

- **RED:** `bun test src/config/preset-inheritance.test.ts` after adding the
  JSON-boundary regression and before the schema fix produced `7 pass`, `1
  fail`, and `28 expect()` calls. The authored `presets.__proto__` key was
  dropped by schema parsing, and resolution threw
  `PRESET_INHERITANCE_MISSING_PARENT` for `child -> __proto__`.
- **Layered RED:** After the schema fix and before the bounded loader merge
  support, the same focused command still produced `7 pass`, `1 fail`, and
  `28 expect()` calls when the authored parent was supplied by the project
  layer over a lower user preset map. This exposed the ordinary deep-merge
  `__proto__` assignment path.
- **GREEN:** `bun test src/config/preset-inheritance.test.ts` after the schema
  boundary and preset-map merge fixes produced `8 pass`, `0 fail`, and `31
  expect()` calls. The test proves the authored own key survives the raw
  config boundary, resolves as a parent, and applies through layered loading.
- **Regression:** `env -u OH_MY_OPENCODE_SLIM_PRESET bun test
  src/config/preset-inheritance.test.ts src/config/loader.test.ts
  src/config/schema.test.ts src/config/project-local-customization.test.ts`
  produced `105 pass`, `0 fail`, and `220 expect()` calls.
- **Scoped validation:** `bunx biome check src/config/schema.ts
  src/config/preset-inheritance.test.ts src/config/loader.ts
  src/config/index.ts`, `bun run generate-schema`, and `git diff --check`
  passed. The generated schema artifact was restored after the viability
  check because generated-schema ownership remains in Wave 3.
- **Caveats:** Full `bun run typecheck` remains blocked by the previously
  documented raw-preset consumer errors in `src/index.ts`,
  `src/tools/preset-switch.ts`, and `src/tui-preset.ts`; those are Wave 2
  consumer migrations and are outside this bounded revision. No remaining
  blocker was found in the Wave 1 regression scope.

## Round 3 - Oracle Review

**Final gate reused:** Task `1.5` — **Owner: @oracle — Wave 1 review gate**. The complete updated Wave 1 was reviewed against tasks `1.1–1.4`, `proposal.md`, `design.md`, and `specs/preset-inheritance/spec.md`. No replacement gate was created.

### Complete W1-A mapping reviewed

- `W1-A`, tasks `1.1–1.4`, owner `@fixer` — raw schema, inheritance resolver, eager loader integration, raw/resolved boundary, and focused tests.
- Round 2 W1-A revision, tasks `1.2` and `1.4`, owner `@fixer` — exact own-key graph membership and prototype-property missing-parent regression.
- Round 3 W1-A schema-boundary revision, tasks `1.1` and `1.4`, owner `@fixer` — prototype-safe preset-key parsing and defined-`__proto__` regression.
- Minimal Round 3 loader support, owner `@fixer` — prototype-safe layered preset-map merging.
- Task `1.5`, owner `@oracle` — this reused final Wave 1 review gate.

### Prior P1 dispositions

Both prior P1 findings are fixed.

1. `resolvePresetInheritance()` uses exact own-key membership at `src/config/loader.ts:405`, and active selection uses the same semantics at `src/config/loader.ts:483-487`. Absent `toString`, `constructor`, `hasOwnProperty`, and `__proto__` parents fail with `PRESET_INHERITANCE_MISSING_PARENT`.
2. `src/config/schema.ts:181-242` preserves exact preset names through Zod parsing using bounded key encoding and prototype-free decoding. `src/config/loader.ts:341-369` preserves those names across layered merging. The JSON/layered regression at `src/config/preset-inheritance.test.ts:202-224` proves an authored own `__proto__` parent survives parsing, merges, resolves, and applies.

### P0

None.

### P1

None.

### P2

1. **FAMILY:** Focused contract coverage  
   **PRIORITY:** P2  
   **IN_SCOPE:** YES  
   **Evidence:** `src/config/preset-inheritance.test.ts:66-156` still does not directly exercise higher-layer omission preserving `$extends`, direct selection of a lower-layer parent-only preset, or array replacement through inheritance. The implementation follows the required merge behavior, so these remain nonblocking coverage gaps.  
   **SUGGESTED_CORRECTION:** Add these mutation-sensitive cases when the focused owner is next extended.

2. **FAMILY:** Schema diagnostic fidelity  
   **PRIORITY:** P2  
   **IN_SCOPE:** YES  
   **Evidence:** Validation errors produced inside `PresetMapInputSchema` expose the internal prefix from `src/config/schema.ts:181-230`; an invalid preset reports a path such as `presets.\u0000oh-my-opencode-slim:preset:invalid.oracle.temperature`. Rejection and fallback remain correct, but diagnostics no longer show the authored name cleanly.  
   **SUGGESTED_CORRECTION:** Decode the bounded sentinel in exposed issue paths without introducing a general validation layer.

3. **FAMILY:** Generated-schema conformance  
   **PRIORITY:** P2  
   **IN_SCOPE:** NO  
   **Evidence:** Current `z.toJSONSchema(..., { io: 'input' })` output represents `z.string().trim().min(1)` as only `minLength: 1`; it does not reject whitespace-only values as required by `spec.md:113-115` and task `3.1`.  
   **DEFERRED_REASON:** Generated-schema publication belongs to Wave 3. Wave 3 must make the source-generated schema express the non-whitespace constraint before publication; omission does not change Wave 1 scope.

### Verification

- Re-ran the full Wave 1 focused regression: `105 pass`, `0 fail`, `220 expect()` calls.
- Independently exercised absent and defined prototype-property names, including layered `__proto__`; all exact-key diagnostics passed.
- Confirmed `git diff --check` passes.
- Confirmed schema generation remains viable and inspected its current input-side preset schema.
- Full type checking reports only the previously documented raw-preset consumer errors in `src/index.ts`, `src/tools/preset-switch.ts`, and `src/tui-preset.ts`; those remain assigned to Wave 2 and were not rescored as Wave 1 blockers.
- Wave 2 consumers, Wave 3 publication/documentation, and repository-wide CI remain outside this gate.

**Gate assessment:** Task `1.5` passes. No P0/P1 remains in Wave 1.

CONSENSUS_STATUS=PASS

## Round 4 - Implementation Assignments

**Wave:** 2 - Supported Preset Consumers
**Final gate reserved:** `2.5` - `@oracle` Wave 2 review gate

### W2-A - @fixer

- **Tasks:** `2.1`, `2.2`, `2.3`, `2.4`
- **Responsibility:** Route supported runtime, startup/reload, disk-switching,
  TUI, doctor, and other non-startup consumers through the resolved preset view;
  preserve raw inheritance metadata for persistence; validate merged candidate
  graphs before every preset save, overwrite, or delete; add focused consumer
  behavior tests.
- **Files/topics:** Existing preset consumers under `src/index.ts`, `src/agents/`,
  `src/config/`, `src/tools/preset-switch.ts`, `src/tui*.ts`, and
  `src/cli/doctor.ts`, plus cohesive consumer tests. Dormant live runtime-preset
  switching is excluded.
- **Required evidence:** Expected RED failures for newly supported consumer
  behavior, focused GREEN results, unchanged-file evidence for rejected TUI
  mutations, scoped type/lint checks, and Wave 1 regression preservation.
- **Status:** Dispatched.

### W2-A Evidence - @fixer

- **Files changed:** `src/agents/index.ts`, `src/cli/doctor.ts`,
  `src/config/index.ts`, `src/config/loader.ts`,
  `src/config/strip-orchestrator-model.ts`,
  `src/config/strip-orchestrator-model.test.ts`, `src/index.ts`,
  `src/tools/preset-switch.ts`, `src/tui-preset.ts`, `src/tui.ts`, and
  `src/preset-inheritance-consumers.test.ts`.
- **RED:** `bun test src/preset-inheritance-consumers.test.ts` before
  production changes produced `2 pass`, `10 fail`, and `14 expect()` calls.
  Failures covered resolved startup fallback, metadata-free stripping,
  parent-only switching, invalid switch rejection, graph-safe save/
  overwrite/delete, and doctor graph diagnostics.
- **GREEN:** `bun test src/preset-inheritance-consumers.test.ts` produced
  `13 pass`, `0 fail`, and `31 expect()` calls. The suite also verifies reload
  after disk selection, raw `$extends` preservation, alias summaries, inline
  prompt inheritance, and child-only prompt-directory lookup.
- **Unchanged-file evidence:** The consumer suite compares the exact user
  config text before and after rejected missing-parent save, cycle overwrite,
  and referenced-parent delete mutations; all three assertions passed.
- **Focused validation:** The consumer/preset/doctor/strip command produced
  `71 pass`, `0 fail`, and `169 expect()` calls. The Wave 1 regression command
  (`env -u OH_MY_OPENCODE_SLIM_PRESET bun test
  src/config/preset-inheritance.test.ts src/config/loader.test.ts
  src/config/schema.test.ts src/config/project-local-customization.test.ts`)
  produced `105 pass`, `0 fail`, and `220 expect()` calls. The isolated agent
  regression produced `93 pass`, `0 fail`, and `199 expect()` calls; the
  secondary-model suite produced `5 pass`, `0 fail`, and `16 expect()` calls.
  Scoped Biome checks and `bun run typecheck` passed.
- **Caveats:** Repository-wide Wave 3 checks were not run. `git diff --check`
  reports the pre-existing trailing whitespace on the Round 4 wave heading at
  line 285; this evidence subsection adds no trailing whitespace. An initial
  unisolated agent test run observed an ambient prompt file; rerunning with
  empty config search paths passed without code changes.

## Round 4 - Oracle Review

**Final gate consumed:** Task `2.5` — **Owner: @oracle — Wave 2 review gate**.

### Complete W2-A mapping reviewed

- Task `2.1` — startup, reload, agent/model, and orchestrator-model consumers in `src/agents/index.ts`, `src/index.ts`, and `src/config/strip-orchestrator-model.ts`.
- Task `2.2` — disk switching, summaries, aliases, TUI CRUD, and candidate persistence validation in `src/tools/preset-switch.ts`, `src/tui-preset.ts`, and `src/tui.ts`.
- Task `2.3` — layered doctor validation and existing non-startup consumers in `src/cli/doctor.ts` and `src/tools/smartfetch/secondary-model.ts`.
- Task `2.4` — `src/preset-inheritance-consumers.test.ts`, `src/config/strip-orchestrator-model.test.ts`, and related preset/doctor tests.
- Task `2.5` — this complete Wave 2 review gate.

### P0

None.

### P1

1. **Resolved presets containing only non-model overrides cannot be selected on disk.**
   - **FAMILY:** Supported disk selection
   - **PRIORITY:** P1
   - **IN_SCOPE:** YES
   - **Evidence:** `src/tools/preset-switch.ts:103-110` determines whether a resolved preset is empty from `buildAgentUpdates()`, but `mapOverrideToAgentConfig()` at `src/tools/preset-switch.ts:145-179` retains only model, temperature, variant, and options. Valid overrides such as inherited `prompt`, `skills`, `mcps`, or `displayName` are discarded.
   - A child inheriting only `oracle.prompt` is rejected as “empty” and is not persisted. This directly breaks supported disk selection of inherited inline-prompt presets.
   - **SUGGESTED_CORRECTION:** Determine emptiness from non-empty agent overrides in the resolved preset, independently of the model-summary projection. Add a regression for a parent-only child inheriting only an inline prompt.

2. **The smartfetch config consumer still swallows fatal inheritance errors.**
   - **FAMILY:** Graph-error propagation
   - **PRIORITY:** P1
   - **IN_SCOPE:** YES
   - **Evidence:** `src/tools/smartfetch/secondary-model.ts:75-110` wraps `loadPluginConfig()` in a broad catch and returns `[]` for every failure. A missing-parent graph was independently observed returning `[]` instead of surfacing `PRESET_INHERITANCE_MISSING_PARENT`.
   - This is the existing non-startup `loadPluginConfig()` consumer explicitly covered by task `2.3`.
   - **SUGGESTED_CORRECTION:** Rethrow `PresetInheritanceError` while retaining the optional fallback for unrelated secondary-model discovery failures. Add focused missing-parent and cycle propagation tests.

3. **Candidate validation can destroy an invalid user file and does not share loader interpolation semantics.**
   - **FAMILY:** Persistence integrity
   - **PRIORITY:** P1
   - **IN_SCOPE:** YES
   - **Evidence:** `readUserConfig()` returns the same `null` for absent, unreadable, and malformed files at `src/tools/preset-switch.ts:293-301`; `writePresetResult()` substitutes `{}` at line 342 and can then overwrite the original file. Independently reproduced: saving a valid preset replaced malformed source text with a new minimal configuration and returned success.
   - `validateCandidateUserConfig()` directly parses and schema-validates raw objects at `src/tools/preset-switch.ts:427-451`, bypassing loader environment interpolation. A configuration where `child.$extends` is `{env:PARENT_PRESET}` loads successfully when the variable names `base`, but every TUI mutation is rejected against the literal placeholder.
   - **SUGGESTED_CORRECTION:** Distinguish absence from parse/read failure and fail closed without writing existing invalid content. Reuse the loader’s parsing/interpolation semantics for candidate layers before graph validation. Add exact unchanged-file and interpolated-parent regressions.

### P2

1. **The TUI loses its effective inherited view after the first edit interaction.**
   - **FAMILY:** Raw/resolved TUI ownership
   - **PRIORITY:** P2
   - **IN_SCOPE:** YES
   - **Evidence:** `editPreset()` initially passes the resolved preset at `src/tui-preset.ts:284-290`, but subsequent calls omit it and fall back to `metadataFreePreset(working)` at lines `293-301`. Inherited agents therefore disappear after editing, cancelling, adding, or removing an agent, even though persistence remains raw.
   - **SUGGESTED_CORRECTION:** Recompute or retain the effective candidate view throughout the editor while continuing to save only the raw working preset.

2. **Save & Apply discards graph diagnostics.**
   - **FAMILY:** TUI error reporting
   - **PRIORITY:** P2
   - **IN_SCOPE:** YES
   - **Evidence:** `src/tui-preset.ts:334-351` requests a silent save and receives only a boolean, then emits a generic write-failure message. The specific missing-parent, cycle, schema, or project-layer diagnostic from `writePresetResult()` is lost.
   - **SUGGESTED_CORRECTION:** Preserve and display the mutation result message on the Save & Apply failure path.

3. **Focused tests are not mutation-sensitive to the uncovered consumer failures.**
   - **FAMILY:** Consumer contract coverage
   - **PRIORITY:** P2
   - **IN_SCOPE:** YES
   - **Evidence:** `src/preset-inheritance-consumers.test.ts:111-152` tests parent-only switching only when inherited models produce `AgentUpdate` entries. It does not test prompt-only selection, smartfetch graph-error propagation, malformed-file preservation, environment-interpolated parents, or the post-interaction TUI effective view.
   - **SUGGESTED_CORRECTION:** Add focused behavioral regressions alongside the corresponding fixes; avoid source-structure assertions.

### P3

None.

### Verification

- Inspected the complete working-tree diff from Wave 1 base `adaf21c`, all W2-A files, the new consumer suite, and existing preset consumers.
- Re-ran the focused consumer/preset/doctor/strip suite: `71 pass`, `0 fail`, `169` expectations.
- `bun run typecheck` passed.
- `git diff --check adaf21c` passed.
- Independently reproduced the prompt-only switch rejection, swallowed smartfetch graph error, malformed-file overwrite, and environment-interpolation mismatch.
- No metadata leakage, prompt-directory inheritance, startup graph swallowing, or dormant live-switch expansion was found in the reviewed paths.
- Wave 3 generated schema, documentation, and repository-wide verification were not scored.

CONSENSUS_STATUS=NEEDS_REVISION

## Round 5 - Implementation Assignments

**Wave:** 2 - Supported Preset Consumers
**Final gate reused:** `2.5` - `@oracle` Wave 2 review gate

### W2-A Revision - @fixer

- **Tasks:** `2.2`, `2.3`, `2.4`
- **Blocking findings:** Prompt-only resolved presets are rejected as empty;
  smartfetch swallows fatal inheritance errors; candidate mutation handling can
  overwrite malformed user files and bypasses loader interpolation semantics.
- **Responsibility:** Add focused failing regressions, fix semantic emptiness and
  dedicated error propagation, make candidate validation fail closed for invalid
  existing files, and share loader-equivalent interpolation before graph checks.
- **Files/topics:** `src/tools/preset-switch.ts`,
  `src/tools/smartfetch/secondary-model.ts`, focused consumer/secondary-model
  tests, and only minimal shared-loader support.
- **Required evidence:** Expected RED failures for every P1, focused GREEN
  results, exact unchanged-file evidence, environment-interpolated parent
  success, prior Wave 2 regression, typecheck, and scoped Biome/diff checks.
- **Status:** Dispatched.

### W2-A Revision Evidence - @fixer

- **RED — disk emptiness and candidate validation:** `bun test
  src/preset-inheritance-consumers.test.ts` produced `13 pass`, `3 fail`, and
  `34 expect()` calls. The prompt-only selection returned `ok: false`, the
  malformed-file mutation returned `true`, and the environment-interpolated
  parent mutation returned `false`.
- **RED — smartfetch propagation:** `bun test
  src/tools/smartfetch/secondary-model.test.ts` produced `5 pass`, `2 fail`,
  and `18 expect()` calls. Both new missing-parent and cycle tests observed a
  resolved `[]` instead of a rejected inheritance error.
- **GREEN — disk and candidate behavior:** `bun test
  src/preset-inheritance-consumers.test.ts` produced `16 pass`, `0 fail`, and
  `37 expect()` calls. The prompt-only parent selection persisted `preset:
  child`; rejected missing-parent save, cycle overwrite, referenced-parent
  delete, and malformed-file save assertions all compared the exact original
  user-config text.
- **GREEN — smartfetch propagation:** `bun test
  src/tools/smartfetch/secondary-model.test.ts` produced `7 pass`, `0 fail`,
  and `18 expect()` calls. Missing-parent and cycle failures propagated with
  `PRESET_INHERITANCE_MISSING_PARENT` and `PRESET_INHERITANCE_CYCLE`.
- **Environment interpolation:** The controlled consumer test set
  `PARENT_PRESET=base`, validated `$extends: '{env:PARENT_PRESET}'`, persisted
  successfully, and confirmed the raw placeholder remained in the saved
  preset.
- **Prior focused Wave 2 regression:** `env -u
  OH_MY_OPENCODE_SLIM_PRESET bun test src/preset-inheritance-consumers.test.ts
  src/config/strip-orchestrator-model.test.ts src/cli/doctor.test.ts
  src/config/preset-inheritance.test.ts src/config/loader.test.ts
  src/config/schema.test.ts src/config/project-local-customization.test.ts
  src/tools/smartfetch/secondary-model.test.ts` produced `161 pass`, `0 fail`,
  and `359 expect()` calls.
- **Wave 1 regression:** `env -u OH_MY_OPENCODE_SLIM_PRESET bun test
  src/config/preset-inheritance.test.ts src/config/loader.test.ts
  src/config/schema.test.ts src/config/project-local-customization.test.ts`
  produced `105 pass`, `0 fail`, and `220 expect()` calls.
- **Validation:** `bun run typecheck`, the scoped Biome command covering
  `src/config/loader.ts`, `src/tools/preset-switch.ts`, both smartfetch files,
  and `src/preset-inheritance-consumers.test.ts`, plus `git diff --check` all
  passed.
- **Caveats:** An initial unisolated Wave 2 regression run observed the ambient
  `OH_MY_OPENCODE_SLIM_PRESET=openai-5.6` and produced unrelated loader-test
  failures; the exact rerun above removed that ambient variable. No P2 work,
  task `2.5`, dormant live switching, or unrelated OpenSpec files were
  changed.

## Round 5 - Oracle Review

**Final gate reused:** Task `2.5` — **Owner: @oracle — Wave 2 review gate**. The complete updated Wave 2 was reviewed against tasks `2.1–2.4`, `proposal.md`, `design.md`, and `specs/preset-inheritance/spec.md`. No replacement gate was created.

### Complete W2-A mapping reviewed

- Task `2.1`, owner `@fixer` — startup/reload, agent/model, orchestrator-model, raw/resolved runtime ownership, inline prompts, and dormant live-switch exclusion in `src/agents/index.ts`, `src/index.ts`, and `src/config/strip-orchestrator-model.ts`.
- Task `2.2`, owner `@fixer` — disk selection, TUI CRUD, summaries, aliases, raw persistence, and candidate graph validation in `src/tools/preset-switch.ts`, `src/tui-preset.ts`, and `src/tui.ts`.
- Task `2.3`, owner `@fixer` — doctor and smartfetch graph-error handling in `src/cli/doctor.ts` and `src/tools/smartfetch/secondary-model.ts`.
- Task `2.4`, owner `@fixer` — focused consumer coverage in `src/preset-inheritance-consumers.test.ts`, `src/tools/smartfetch/secondary-model.test.ts`, `src/config/strip-orchestrator-model.test.ts`, and related suites.
- Round 5 W2-A revision, tasks `2.2`, `2.3`, and `2.4`, owner `@fixer` — semantic disk-selection emptiness, smartfetch fatal-error propagation, fail-closed user-config mutation handling, and loader-equivalent candidate interpolation.
- Task `2.5`, owner `@oracle` — this reused complete Wave 2 review gate.

### Prior P1 dispositions

1. **Disk-selection semantic emptiness is only partially fixed.** Prompt-only inherited presets are now selectable, but genuinely empty agent overrides are accepted.
2. **Smartfetch propagation is fully fixed.** `PresetInheritanceError` is rethrown at `src/tools/smartfetch/secondary-model.ts:108-110`, while unrelated optional-discovery failures still return `[]`. Both dedicated codes have focused coverage.
3. **Candidate mutation integrity is partially fixed.** Malformed existing user files are preserved byte-for-byte, and `$extends` interpolation works. However, schema validation still occurs against the uninterpolated raw user configuration before candidate validation.

### P0

None.

### P1

1. **Genuinely empty resolved presets are now accepted by disk selection.**
   - **FAMILY:** Supported disk-selection emptiness
   - **PRIORITY:** P1
   - **IN_SCOPE:** YES
   - **Evidence:** `src/tools/preset-switch.ts:104-111` checks only `Object.keys(preset).length`. A resolved preset such as `{ oracle: {} }` therefore succeeds even though no agent has a non-empty override. The previous behavior rejected this configuration, so presets without `$extends` are no longer behaviorally unchanged.
   - **Independent reproduction:** `switchPresetOnDisk()` returned `ok: true` and an empty summary for `{ resolvedPresets: { empty: { oracle: {} } } }`.
   - **SUGGESTED_CORRECTION:** Reject the preset unless at least one resolved agent override has an own configuration field. Keep prompt, skills, MCP, display-name, permission, and other non-model fields valid.

2. **Candidate mutation pre-validation still rejects loader-valid environment-interpolated user configurations.**
   - **FAMILY:** Candidate validation parity
   - **PRIORITY:** P1
   - **IN_SCOPE:** YES
   - **Evidence:** `readUserConfig()` parses without interpolation at `src/tools/preset-switch.ts:303-305` and immediately schema-validates that raw value at lines `316-323`. Consequently, placeholders in schema-constrained string fields are rejected before `validateCandidateUserConfig()` applies loader interpolation.
   - **Independent reproduction:** With `ROUTING_MODE=direct`, a user config containing `"image_routing": "{env:ROUTING_MODE}"` loaded successfully as `direct`, but `writePresetResult()` returned `ok: false` with “existing user config does not match the plugin schema”; the file remained unchanged.
   - **SUGGESTED_CORRECTION:** Preserve the non-interpolated parsed object for persistence, but validate a separately interpolated parse using `parseConfigContent()` before constructing and validating the candidate.

3. **Doctor does not use loader environment-interpolation semantics for inheritance.**
   - **FAMILY:** Doctor/loader validation parity
   - **PRIORITY:** P1
   - **IN_SCOPE:** YES
   - **Evidence:** `checkConfigFile()` uses `JSON.parse(stripJsonComments(content))` at `src/cli/doctor.ts:94-97`, bypassing `parseConfigContent()`. Doctor therefore resolves the literal placeholder rather than the effective parent name.
   - **Independent reproduction:** With `PARENT_PRESET=base`, `loadPluginConfig()` resolved `child` to `base/model`, while `runDoctorCheck()` returned `PRESET_INHERITANCE_MISSING_PARENT` for literal `{env:PARENT_PRESET}`.
   - **SUGGESTED_CORRECTION:** Parse doctor inputs through the shared loader JSONC/interpolation function before per-file schema checks and merged graph validation. Add a focused interpolated-parent doctor regression.

### P2

1. **The TUI still loses its effective inherited view after the first edit interaction.**
   - **FAMILY:** Raw/resolved TUI ownership
   - **PRIORITY:** P2
   - **IN_SCOPE:** YES
   - **Evidence:** `editPreset()` supplies the resolved view at `src/tui-preset.ts:284-290`, but subsequent calls omit it and fall back to the raw working preset at lines `293-301`. Inherited agents disappear after editing, cancelling, adding, or removing an agent.
   - **SUGGESTED_CORRECTION:** Recompute or retain the effective candidate view while persisting only the raw working definition.

2. **Save & Apply still discards specific mutation diagnostics.**
   - **FAMILY:** TUI error reporting
   - **PRIORITY:** P2
   - **IN_SCOPE:** YES
   - **Evidence:** `src/tui-preset.ts:334-351` invokes silent save and emits a generic write-failure message rather than the missing-parent, cycle, schema, or read diagnostic.
   - **SUGGESTED_CORRECTION:** Return and display `PresetMutationResult` on the silent Save & Apply path.

3. **Prompt-only disk selection produces an empty switch summary.**
   - **FAMILY:** Resolved preset summaries
   - **PRIORITY:** P2
   - **IN_SCOPE:** YES
   - **Evidence:** `src/tools/preset-switch.ts:104-120` accepts the resolved preset but builds its summary through `buildAgentUpdates()`, which drops prompt, skills, MCP, display-name, and permission-only overrides at lines `128-139`.
   - **SUGGESTED_CORRECTION:** Build summary membership from resolved agent entries while retaining the existing model-specific details where present.

### Verification

- Re-ran the complete focused Wave 2 regression: `161 pass`, `0 fail`, `359 expect()` calls.
- Re-ran `bun run typecheck`; it passed.
- Confirmed `git diff --check` passes.
- Independently verified prompt-only selection and smartfetch dedicated-error coverage.
- Adversarial checks reproduced empty-override acceptance, candidate rejection of a loader-valid interpolated config, and doctor’s interpolated-parent false failure.
- Startup/reload application, runtime resolved ownership, metadata exclusion, aliases, inline prompt inheritance, child-only prompt-directory lookup, malformed-file preservation, graph-safe save/overwrite/delete, and live-switch exclusion otherwise showed no additional P0/P1 regression.
- Wave 3 schema publication, documentation, whole-repository checks, and the explicitly excluded unrelated OpenSpec files were not scored.

**Gate assessment:** Task `2.5` remains blocked by the three P1 findings above.

CONSENSUS_STATUS=NEEDS_REVISION

## Round 6 - Implementation Assignments

**Wave:** 2 - Supported Preset Consumers
**Final gate reused:** `2.5` - `@oracle` Wave 2 review gate

### W2-A Validation-Parity Revision - @fixer

- **Tasks:** `2.2`, `2.3`, `2.4`
- **Owner replacement:** A fresh `@fixer` session replaces the unavailable prior
  W2-A session while preserving the same task/topic ownership.
- **Blocking findings:** Genuinely empty agent overrides are accepted; raw
  environment placeholders are schema-validated before their interpolated view;
  doctor bypasses shared loader interpolation.
- **Responsibility:** Add focused RED regressions, enforce semantic non-empty
  agent overrides, maintain raw-for-write and interpolated-for-validation config
  views, and route doctor parsing through the shared loader parser.
- **Files/topics:** `src/tools/preset-switch.ts`, `src/cli/doctor.ts`, focused
  consumer/doctor tests, and only minimal shared parsing support.
- **Required evidence:** Expected RED failures for each P1, focused GREEN results,
  prior Wave 2 and Wave 1 regressions, typecheck, scoped Biome, and diff check.
- **Status:** Initial replacement launch interrupted without a task ID. Partial
  writes in the assigned files were inspected and transferred to a fresh
  replacement owner; verification remains pending.

### W2-A Validation-Parity Revision Evidence - @fixer

- **Interrupted handoff:** The replacement launch returned no task ID. The
  partial writes in `src/cli/doctor.test.ts`, `src/cli/doctor.ts`,
  `src/tools/preset-switch.ts`, and
  `src/preset-inheritance-consumers.test.ts` were inspected and continued;
  they were not reverted to restart TDD. `src/config/loader.ts` remained the
  minimal shared parser support.
- **RED:** The handoff's recorded pre-fix counts were not accepted as current
  RED evidence because the partial production writes were already present.
  Re-running the focused regressions found no remaining defect failure: the
  empty-agent rejection, prompt-only acceptance, raw-placeholder persistence,
  and interpolated-doctor-parent cases all passed.
- **GREEN:** `bun test src/preset-inheritance-consumers.test.ts
  src/cli/doctor.test.ts` produced `46 pass`, `0 fail`, and `123 expect()` calls.
  The tests prove empty resolved overrides are rejected, prompt-only overrides
  remain selectable, raw `image_routing` is preserved while its effective value
  validates, and doctor resolves an interpolated `$extends` parent.
- **Prior Wave 2 regression:** `env -u OH_MY_OPENCODE_SLIM_PRESET bun test
  src/preset-inheritance-consumers.test.ts src/config/strip-orchestrator-model.test.ts
  src/cli/doctor.test.ts src/config/preset-inheritance.test.ts
  src/config/loader.test.ts src/config/schema.test.ts
  src/config/project-local-customization.test.ts
  src/tools/smartfetch/secondary-model.test.ts` produced `164 pass`, `0 fail`,
  and `369 expect()` calls.
- **Wave 1 regression:** `env -u OH_MY_OPENCODE_SLIM_PRESET bun test
  src/config/preset-inheritance.test.ts src/config/loader.test.ts
  src/config/schema.test.ts src/config/project-local-customization.test.ts`
  produced `105 pass`, `0 fail`, and `220 expect()` calls.
- **Changed files:** The bounded revision continued the four assigned partial
  files plus `src/config/loader.ts` for shared JSONC/interpolation parsing. No
  second parser or generalized validation layer was introduced.
- **Validation:** `bun run typecheck`,
  `bunx biome check src/tools/preset-switch.ts src/cli/doctor.ts
  src/preset-inheritance-consumers.test.ts src/cli/doctor.test.ts
  src/config/loader.ts`, and `git diff --check` all passed.
- **Blockers:** None observed. Task `2.5` remains excluded as the only Oracle
  gate; dormant live switching and unrelated OpenSpec files remain untouched.

## Round 6 - Oracle Review

**Final gate reused:** Task `2.5` — **Owner: @oracle — Wave 2 review gate**. The complete updated Wave 2 was reviewed against tasks `2.1–2.4`, `proposal.md`, `design.md`, and `specs/preset-inheritance/spec.md`. No replacement gate was created.

### Complete W2-A mapping reviewed

- Task `2.1`, owner `@fixer` — startup/reload, agent/model, orchestrator-model, resolved runtime ownership, inline prompts, and dormant live-switch exclusion in `src/agents/index.ts`, `src/index.ts`, and `src/config/strip-orchestrator-model.ts`.
- Task `2.2`, owner `@fixer` — disk selection, TUI CRUD, summaries, aliases, raw persistence, semantic emptiness, and candidate graph validation in `src/tools/preset-switch.ts`, `src/tui-preset.ts`, and `src/tui.ts`.
- Task `2.3`, owner `@fixer` — doctor and smartfetch fatal graph-error handling in `src/cli/doctor.ts` and `src/tools/smartfetch/secondary-model.ts`.
- Task `2.4`, owner `@fixer` — focused consumer coverage in `src/preset-inheritance-consumers.test.ts`, `src/cli/doctor.test.ts`, `src/tools/smartfetch/secondary-model.test.ts`, and `src/config/strip-orchestrator-model.test.ts`.
- Round 5 W2-A revision, tasks `2.2–2.4`, owner `@fixer` — prompt-only selection, smartfetch propagation, fail-closed malformed-file handling, and candidate interpolation.
- Round 6 W2-A validation-parity revision, tasks `2.2–2.4`, owner `@fixer` — semantic emptiness, raw/effective candidate validation, and doctor interpolation parity. The interrupted assigned-file writes were reconciled and completed; no orphaned partial implementation was apparent.
- Task `2.5`, owner `@oracle` — this reused complete Wave 2 review gate.

### Prior P1 dispositions

All exact Round 4 and Round 5 reproductions are fixed:

1. Prompt-only and other non-model resolved overrides remain selectable, while presets whose agent overrides all have zero own fields are rejected at `src/tools/preset-switch.ts:103-113`.
2. Smartfetch rethrows both dedicated inheritance errors at `src/tools/smartfetch/secondary-model.ts:108-110`.
3. Malformed user configurations remain unchanged, and schema-constrained raw placeholders are validated through a separately interpolated view at `src/tools/preset-switch.ts:300-331` and `src/tools/preset-switch.ts:470-511`.
4. Doctor now uses shared JSONC/interpolation parsing before schema and merged-graph validation at `src/cli/doctor.ts:94-117`.

### P0

None.

### P1

1. **The TUI edit/save round-trip still overwrites user-owned raw `$extends` metadata with the merged, interpolated value.**
   - **FAMILY:** Raw/resolved TUI ownership and persistence integrity
   - **PRIORITY:** P1
   - **IN_SCOPE:** YES
   - **Evidence:** `loadPluginConfig()` interpolates each file before schema parsing at `src/config/loader.ts:71-83` and returns the merged effective `config.presets`. `editPreset()` then takes its persistence working copy from that effective map at `src/tui-preset.ts:284-290`, and `savePreset()` writes it back at `src/tui-preset.ts:460-483`.
   - An independent round-trip with raw `$extends: '{env:PARENT_PRESET}'` loaded `$extends: 'base'`; saving the unchanged TUI working preset succeeded but permanently replaced the placeholder with `"base"`.
   - A second layered reproduction used user `$extends: 'baseA'` and project `$extends: 'baseB'`. The TUI-equivalent round-trip copied `"baseB"` into the user file, destroying the lower-layer `"baseA"` declaration.
   - This violates task `2.2` and the canonical raw-definition ownership boundary. Round 6 correctly preserves untouched raw fields inside the mutation backend, but the TUI caller no longer supplies the raw user-owned preset being persisted.
   - **SUGGESTED CORRECTION:** Keep the TUI working definition sourced from the exact user-layer raw preset while using `resolvedPresets` only for its effective display. Preserve candidate merge and effective validation as implemented. Add focused full load→edit/save round-trips for an environment-backed parent and a project-overridden parent. This is deterministic persistence state and warrants a bounded direct fix, not generalized validation machinery.

### P2

1. `src/tui-preset.ts:293-301` still loses the effective inherited editor view after the first interaction because recursive calls omit the resolved view and fall back to the raw working preset.
2. `src/tui-preset.ts:334-351` still replaces the specific mutation diagnostic with a generic message on Save & Apply failure.
3. `src/tools/preset-switch.ts:103-123` still returns an empty summary for prompt-only or other non-model-only presets because summary projection uses `buildAgentUpdates()`.

These are nonblocking under the requested gate.

### Verification

- Re-ran the complete Wave 2 regression: `164 pass`, `0 fail`, `369 expect()` calls.
- Re-ran `bun run typecheck`; it passed.
- Confirmed `git diff --check` passes.
- Independently reproduced both raw-metadata corruption paths described above.
- Startup/reload inheritance, metadata exclusion, semantic emptiness, graph-safe rejected mutations, doctor and smartfetch fatal errors, inline prompt inheritance, parent prompt-directory exclusion, and dormant live-switch exclusion showed no additional P0/P1.
- Wave 3 publication, documentation, generated schema, and whole-repository checks were not scored.

**Gate assessment:** Task `2.5` remains blocked by the P1 raw TUI persistence defect. `REVIEW_ACTION=PATCH`.

CONSENSUS_STATUS=NEEDS_REVISION

## Round 7 - Implementation Assignments

**Wave:** 2 - Supported Preset Consumers
**Final gate reused:** `2.5` - `@oracle` Wave 2 review gate

### W2-A Raw TUI Ownership Revision - @fixer

- **Tasks:** `2.2`, `2.4`
- **Blocking finding:** TUI edit/save initializes its persistence working copy
  from merged/interpolated presets, overwriting user-owned raw `$extends`
  placeholders or lower-layer declarations on unchanged save.
- **Responsibility:** Source the TUI persistence working definition from the exact
  user-layer raw preset while retaining resolved presets for effective display;
  add full load→edit/save round-trip regressions for environment-backed and
  project-overridden parents.
- **Files/topics:** `src/tui-preset.ts`, the smallest existing raw user-config
  helper surface, and focused TUI/consumer tests only.
- **Required evidence:** Expected RED corruption reproductions, focused GREEN
  round trips proving exact raw declaration preservation, prior Wave 2 and Wave 1
  regressions, typecheck, scoped Biome, and diff check.
- **Status:** Dispatched.

### W2-A Raw TUI Ownership Revision Evidence - @fixer

- **RED:** `bun test src/preset-inheritance-consumers.test.ts -t 'TUI
  preset persistence validation'` after adding the two full load→TUI
  edit/save round trips and before the production fix produced `8 pass`,
  `2 fail`, `23 expect()` calls. The environment-backed parent was written as
  `"base"` instead of the raw `"{env:PARENT_PRESET}"` placeholder, and the
  project-overridden parent was written as `"baseB"` instead of the user's raw
  `"baseA"` declaration.
- **GREEN:** The same focused command after the fix produced `10 pass`,
  `0 fail`, and `23 expect()` calls. Both tests load the effective config,
  drive the actual TUI list→edit→save callbacks, and then parse the user file
  to assert the exact raw `$extends` values. The first assertion preserves
  `"{env:PARENT_PRESET}"` while `loadPluginConfig()` and
  `resolvedPresets.child.oracle.model` use the effective `base` parent. The
  second preserves user `"baseA"` while the merged effective config and
  validation use project `"baseB"`.
- **Wave 2 regression:** `env -u OH_MY_OPENCODE_SLIM_PRESET bun test
  src/preset-inheritance-consumers.test.ts src/config/strip-orchestrator-model.test.ts
  src/cli/doctor.test.ts src/config/preset-inheritance.test.ts
  src/config/loader.test.ts src/config/schema.test.ts
  src/config/project-local-customization.test.ts
  src/tools/smartfetch/secondary-model.test.ts` produced `166 pass`, `0 fail`,
  and `375 expect()` calls.
- **Wave 1 regression:** `env -u OH_MY_OPENCODE_SLIM_PRESET bun test
  src/config/preset-inheritance.test.ts src/config/loader.test.ts
  src/config/schema.test.ts src/config/project-local-customization.test.ts`
  produced `105 pass`, `0 fail`, and `220 expect()` calls.
- **Changed files:** `src/tui-preset.ts` now initializes the persistence
  working copy from the exact user-layer raw preset while retaining
  `resolvedPresets` for TUI display. `src/tools/preset-switch.ts` exposes the
  smallest raw-user-preset reader by reusing its existing validated raw config
  read. `src/preset-inheritance-consumers.test.ts` adds the two round-trip
  regressions. This review log received this evidence subsection only.
- **Validation:** `bun run typecheck`, `bunx biome check src/tui-preset.ts
  src/tools/preset-switch.ts src/preset-inheritance-consumers.test.ts`, and
  `git diff --check` all passed.
- **Caveats:** The focused test stubs only `@opentui/solid` element helpers so
  it can exercise the TUI callback flow in this checkout, where the optional
  package's `solid-js` peer is unavailable; no production TUI rendering path
  is mocked. P2 TUI effective-view recursion, Save & Apply diagnostics, and
  non-model summary projection remain out of scope.
- **Blockers:** None observed. Task `2.5`, dormant live switching, task
  checkboxes, Oracle sections, consensus status, unrelated OpenSpec files, and
  commit history were not changed.

## Round 7 - Oracle Review

**Gate reused:** Task `2.5` — complete Wave 2 review against tasks `2.1–2.4`
and the canonical proposal, design, and specification.

### P0

None.

### P1

None.

The Round 6 blocker is fixed. `readRawUserPreset()` preserves the exact
validated user-layer definition in `src/tools/preset-switch.ts`; `editPreset()`
uses that raw definition for persistence while retaining `resolvedPresets` for
effective display in `src/tui-preset.ts`. Saving still passes through effective
candidate schema and merged-graph validation.

The full TUI callback regressions in
`src/preset-inheritance-consumers.test.ts` prove both previously failing cases:
environment-backed `$extends` remains raw, and a project parent override is not
copied into the user layer.

### Verification

- Complete Wave 2 regression: `166 pass`, `0 fail`, `375` expectations.
- Focused TUI persistence validation: `10 pass`, `0 fail`, `23` expectations.
- `bun run typecheck`, scoped Biome, and `git diff --check` passed.
- Recorded RED evidence matches the prior defect and the current tests are
  mutation-sensitive to both corruption paths.
- Previously accepted P2 items and Wave 3 publication, documentation, schema
  generation, and repository-wide checks were not scored.

### Gate assessment

Task `2.5` passes. No P0/P1 correctness blocker remains in Wave 2.

REVIEW_ACTION=PASS
CONSENSUS_STATUS=PASS

## Round 8 - Implementation Assignments

**Wave:** 3 - Published Contract and Verification
**Final gate reserved:** `3.4` - `@oracle` Wave 3 review gate

### W3-A Published Schema and Documentation - @junior-engineer

- **Tasks:** `3.1`, `3.2`
- **Responsibility:** Regenerate the published JSON schema from the source Zod
  schema and synchronize README/configuration/project-local/preset-switching
  documentation with the approved v1 inheritance contract.
- **Files/topics:** `oh-my-opencode-slim.schema.json`, `README.md`,
  `docs/configuration.md`, `docs/project-local-customization.md`,
  `docs/preset-switching.md`, and this evidence log.
- **Required evidence:** Exact generation command, generated `$extends` shape
  inspection, documentation coverage matrix, scoped formatting/check results,
  changed-file list, caveats, and blockers.
- **Status:** Dispatched.

### W3-A Published Schema and Documentation Evidence - @junior-engineer

**Generation command:**
```bash
bun run generate-schema
```
This runs `scripts/generate-schema.ts`, which calls `z.toJSONSchema(PluginConfigSchema, { io: 'input' })` and writes `oh-my-opencode-slim.schema.json`.

**Schema verification (26 checks, 0 failed):**
- `$extends` is an optional property on each preset entry (not in `required` array).
- Shape: `{ anyOf: [ { type: "string", minLength: 1, pattern: "\\S" }, { type: "null" } ] }` — the `pattern: "\\S"` constraint rejects empty and whitespace-only values as required by `spec.md:113-115`.
- Ordinary agent override fields (`model`, `temperature`, `variant`, `skills`, `mcps`, `prompt`, `orchestratorPrompt`, `options`, `displayName`, `permission`) remain under the catchall `additionalProperties` with `additionalProperties: false` — unchanged validation strictness.
- No `$extends` leaks into `agents` entries or into the agent-override catchall.
- Full verification script at `/tmp/verify-schema.js` — see Round 8 command output above.

**Generated-schema conformance (resolved P2 from Round 3 Oracle):** The source schema `PresetParentSchema` now includes `.regex(/\S/)` which serializes to `pattern: "\\S"` in JSON Schema. The generated `$extends` entry rejects `""` and `"   "` while accepting `"base"` and `"my-preset_42"` and `null`. The Zod runtime still trims surrounding whitespace for valid names via `.trim()`.

- **RED** (before fix): `bun test -t "generated schema rejects"` — `stringBranch.pattern` is `undefined` (current schema has `minLength: 1` only).
- **GREEN** (after fix): `bun test -t "generated schema rejects"` — 1 pass, `pattern: "\\S"` in string branch, all value assertions pass:
  - `re.test('')` → `false`
  - `re.test('   ')` → `false`
  - `re.test('base')` → `true`
  - `re.test('my-preset_42')` → `true`
- **Artifact:** `oh-my-opencode-slim.schema.json` → `$extends` branch: `{ type: "string", minLength: 1, pattern: "\\S" }`.

**Documentation requirements-to-coverage matrix:**

| Requirement | Coverage |
|---|---|
| `$extends` syntax (name or null) | `docs/preset-switching.md` Syntax section; `docs/configuration.md` table entry |
| `$extends: null` detachment | `docs/preset-switching.md` Syntax bullet + Layered Parent Resolution |
| Layered merge (omit/string/null) | `docs/preset-switching.md` Layered Parent Resolution section |
| Precedence parent < child < root agents | `docs/preset-switching.md` Merge Precedence section |
| Deep-merge nested objects, replace arrays/primitives | `docs/preset-switching.md` Merge Precedence section |
| Missing parents and cycles are fatal graph errors | `docs/preset-switching.md` Inheritance Graph Validation section |
| Distinction from malformed JSON/schema fallback | `docs/preset-switching.md` Inheritance Graph Validation (last para) |
| Parent-only presets are selectable | `docs/preset-switching.md` Parent-Only Presets section |
| Startup/reload use resolved inheritance | `docs/preset-switching.md` Reload Behavior section |
| TUI preserves raw `$extends`, validates candidate graphs | `docs/preset-switching.md` TUI Behavior section |
| Inline prompt fields inherit | `docs/preset-switching.md` Prompt Inheritance section |
| Parent preset prompt directories do not inherit | `docs/preset-switching.md` Prompt Inheritance section |
| V1 excludes dormant live runtime-preset switching | `docs/preset-switching.md` Reload Behavior (last sentence) |
| Existing presets without `$extends` remain valid | `docs/preset-switching.md` Syntax (last bullet) + example `standalone` |
| README highlight mention | `README.md` bullet in preset-switching feature entry |
| Project-local customization mention | `docs/project-local-customization.md` Feature Comparison table |

**Scoped validation:**
- `bun run generate-schema` — succeeded (this round's primary operation).
- `git diff --check` — passed (no trailing whitespace or merge conflict markers).
- Schema structural verification — 26/26 checks passed (see script output above).
- Focused regression: `bun test -t "generated schema rejects"` — 1 pass, 7 `expect()` calls (proves pattern constraint rejects whitespace-only, accepts valid names and null).
- Full preset-inheritance suite: `bun test -t "preset inheritance"` — 9 pass, 38 `expect()` calls.
- `bun run typecheck` — passed.
- `bun run check:ci` — passed (0 errors).

**Changed files (Wave 3 W3-A submission):**
- `oh-my-opencode-slim.schema.json` — regenerated; adds `$extends` property to preset entry schema with `pattern: "\\S"`.
- `README.md` — added `$extends` mention to preset-switching highlight.
- `docs/configuration.md` — added `presets.<name>.$extends` option table entry.
- `docs/project-local-customization.md` — updated Presets feature description.
- `docs/preset-switching.md` — added complete Preset Inheritance section covering all v1 contract requirements.
- `docs/plans/reviews/preset-inheritance-implementation-review.md` — this evidence subsection.

**Changed files (this correction — generated-schema P2 resolution):**
- `src/config/schema.ts` — `PresetParentSchema` gains `.regex(/\S/)` to express the non-whitespace constraint in JSON Schema.
- `src/config/preset-inheritance.test.ts` — adds focused generated-artifact regression `generated schema rejects whitespace-only $extends values`.
- `oh-my-opencode-slim.schema.json` — regenerated; string branch now includes `"pattern": "\\S"` alongside existing `"minLength": 1`.
- `docs/plans/reviews/preset-inheritance-implementation-review.md` — this evidence subsection (replaced deferred caveat with RED/GREEN evidence).

**Unrelated working-tree change (not owned):**
- `.gitignore` — pre-existing addition of `.worktrees/` from a prior session; not touched by this work.

**Blockers:** None. Tasks 3.1 and 3.2 are complete. Task checkboxes (`tasks.md`) remain unmarked — the workflow marks all Wave 3 tasks only after the single task 3.4 Oracle PASS.

### W3-B Repository Verification Evidence - Orchestrator

- **Focused inheritance and consumers:** `bun test
  src/config/preset-inheritance.test.ts
  src/preset-inheritance-consumers.test.ts` produced `29 pass`, `0 fail`, and
  `87 expect()` calls.
- **TUI mock isolation RED:** `bun test
  src/preset-inheritance-consumers.test.ts src/tui.test.ts` initially failed
  because the unavoidable process-global `@opentui/solid` test double omitted
  `setProp`, which `src/tui.ts` imports.
- **TUI mock isolation GREEN:** After adding the missing no-op export, the same
  two-file command produced `36 pass`, `0 fail`, and `74 expect()` calls. This
  removes feature-introduced mock interference from the full suite.
- **Generated artifact drift:** SHA-256 before and after `bun run
  generate-schema` remained
  `db52dc764448144797da65c231dd17cb233f0067fccd02572d95ed084dcdae2a`.
- **Type and diff validation:** `bun run typecheck` and `git diff --check`
  passed.
- **Repository Biome check:** `bun run check:ci` reported only formatting in
  `src/hooks/cache-safety.property.test.ts` and `src/utils/env.test.ts`. Running
  the same command from detached parent `2e495e5^` reports the same two files
  and `Found 2 errors`; neither file is changed by preset inheritance.
- **Full repository tests:** `bun test` produced `1744 pass`, `2 fail`, no
  unhandled errors, and `3907 expect()` calls. The two failures are
  environment-sensitive baseline cases in `src/agents/index.test.ts` (the real
  user prompt directory appends the configured `.env` safety block) and
  `src/cli/system.test.ts` (`/usr/bin/opencode` wins the test's explicit PATH).
  A detached `2e495e5^` baseline produced `1704 pass`, `3 fail`, and `1 error`:
  the same two failures plus the checkout's missing optional `solid-js` peer in
  `src/tui.test.ts`. The Wave 3 test double makes that TUI suite load cleanly;
  no new full-suite failure remains.
- **Changed verification file:**
  `src/preset-inheritance-consumers.test.ts` adds only the missing `setProp`
  no-op to its existing OpenTUI test double.
- **Blockers:** No preset-inheritance blocker. The two repository-wide check
  failures are unchanged baseline debt and remain outside this change.

## Round 8 - Oracle Review

**Gate reused:** Task `3.4` — complete Wave 3 review against tasks `3.1–3.3`
and the canonical proposal, design, and specification.

### P0

None.

### P1

1. **Published documentation still advertises unsupported live `/preset`
   activation.**
   - `README.md` says `/preset` swaps models “at runtime.”
   - `docs/configuration.md` says presets switch “without restarting” and
     retains a dormant-runtime precedence claim.
   - `docs/preset-switching.md` retains a runtime-versus-restart distinction
     even though supported `/preset` changes require reload.
   - These statements contradict the implementation and the canonical
     exclusion of dormant live runtime switching. Users may incorrectly expect
     immediate model or precedence changes in the current session.
   - **Required correction:** Describe `/preset` as selecting and persisting a
     preset during a session, with effective agent changes applied only after
     reload or a new conversation. Remove the dormant-runtime precedence claim.

### Verification assessment

- The generated schema correctly exposes optional `$extends` as a string with
  `minLength: 1` and `pattern: "\\S"`, or `null`, without weakening ordinary
  agent-entry validation.
- `PresetParentSchema` preserves runtime trimming and whitespace rejection, and
  the generated-artifact regression is contract-focused and mutation-sensitive.
- The process-global OpenTUI double now exports every helper imported by current
  TUI modules; the combined consumer/TUI run passes.
- Focused inheritance/consumer and consumer/TUI checks pass; schema generation
  is stable; typecheck and `git diff --check` pass.
- The two repository formatting errors and two full-suite failures reproduce in
  paths unchanged from `2e495e5^` and do not block preset inheritance.

### Gate assessment

Tasks `3.1` and `3.3` are acceptable, but task `3.2` remains blocked by the
live-switch documentation contradiction. Return W3-A for a bounded
documentation correction.

REVIEW_ACTION=PATCH
CONSENSUS_STATUS=NEEDS_REVISION

## Round 9 - Implementation Assignments

**Wave:** 3 - Published Contract and Verification
**Final gate reused:** `3.4` - `@oracle` Wave 3 review gate

### W3-A Live-Switch Documentation Correction - @junior-engineer

- **Task:** `3.2`
- **Blocking finding:** Public docs imply that `/preset` immediately changes
  runtime agents/models, contradicting reload-only supported behavior and the
  dormant live-switch exclusion.
- **Responsibility:** Correct only the contradictory statements in README,
  configuration, and preset-switching docs; preserve the accepted inheritance
  documentation and generated schema.
- **Required evidence:** Before/after contradiction inventory, scoped doc diff,
  terminology consistency check, and `git diff --check`.
- **Status:** Dispatched.

### W3-A Live-Switch Documentation Correction Evidence - @junior-engineer

**Contradictory statements removed/replaced:**

| Doc | Location | Before | After |
|---|---|---|---|
| `README.md` | Feature highlights | "swap the whole team's models at runtime with `/preset`" | "select and persist a preset with `/preset`" |
| `README.md` | Docs features table | "Switch agent model presets at runtime with `/preset`" | "Select and persist presets with `/preset`; effective after reload" |
| `docs/configuration.md` | Section header | "### Runtime Preset Switching" | "### In-Session Preset Selection" |
| `docs/configuration.md` | Section body | "Presets can also be switched at runtime without restarting using the `/preset` command." | "The `/preset` command opens the TUI preset manager to select and persist a preset name. The effective agent/model changes apply only after plugin reload or a new conversation." |
| `docs/configuration.md` | Dormant-runtime precedence | Full paragraph: "**Runtime presets reverse this.** When a preset is activated at runtime via the `/preset` command..." | Removed entirely. Only canonical load/reload precedence parent < child < root `agents` remains. |
| `docs/preset-switching.md` | Opening sentence | "Switch agent model presets at runtime using the `/preset` TUI slash command." | "Select and persist a preset using the `/preset` TUI slash command. Effective agent/model changes apply only after plugin reload or a new conversation." |
| `docs/preset-switching.md` | Supported Fields | "Fields not applied at runtime (require restart):" | "These fields take effect only after reload:" |
| `docs/preset-switching.md` | Section header | "## Startup Preset vs Runtime Switching" | "## Preset Activation Methods" |

**Final terminology used across all three owned docs:**
- `/preset` described as "select and persist" a preset name.
- Effective changes apply only after "plugin reload or a new conversation".
- No claims of immediate, runtime, or restart-free model/agent activation.
- Only canonical load/reload precedence (parent < child < root `agents`) documented.

**Preserved inheritance documentation (unchanged from Round 8):**
- `$extends` syntax with non-empty preset name or `null`
- `$extends: null` detachment
- Layered omit/string/null parent resolution
- Merge precedence: oldest ancestor → child → root `agents`; deep-merge objects, replace arrays/primitives
- Fatal graph errors for missing parents and cycles (distinct from malformed JSON/schema fallback)
- Parent-only presets are selectable
- TUI preserves raw `$extends`, validates merged candidate graphs, rejects invalid mutations
- Inline prompt fields inherit; parent prompt directories do not
- V1 excludes dormant live runtime-preset switching
- Existing presets without `$extends` remain valid

**Scoped validation:**
- `git diff --check` — passed
- Targeted grep search across `README.md`, `docs/configuration.md`, `docs/preset-switching.md`:
  - `"at runtime"` — 0 matches
  - `"without restart"` — 0 matches
  - `"immediate"` — only "immediate parent" (inheritance chain, not timing)
  - `"runtime"` — only the unrelated `OPENCODE_CONFIG_DIR` env description

**Changed files:**
- `README.md` — two corrections (feature highlight + docs table)
- `docs/configuration.md` — section header rename, body rewrite, dormant-runtime paragraph removed
- `docs/preset-switching.md` — opening sentence, supported-fields label, section header renamed
- `docs/plans/reviews/preset-inheritance-implementation-review.md` — this evidence subsection

**Blockers:** None. Task 3.2 documentation correction complete.

## Round 9 - Oracle Review

### P0

None.

### P1

None.

The prior documentation blocker is fully resolved:

- `README.md` now describes `/preset` as selection and persistence, effective
  after reload.
- `docs/configuration.md` states that effective changes require plugin reload
  or a new conversation and retains only canonical root-agent precedence.
- `docs/preset-switching.md` consistently documents reload-only activation and
  explicitly excludes live runtime switching.
- No affirmative immediate-activation, restart-free, or live-switch claims
  remain.

### Verification assessment

- Canonical precedence remains oldest parent → child → root `agents`.
- Accepted inheritance documentation remains intact.
- The generated schema hash remains
  `db52dc764448144797da65c231dd17cb233f0067fccd02572d95ed084dcdae2a`;
  task `3.1` remains acceptable.
- Focused inheritance and consumer tests pass: `29 pass`, `0 fail`, and `87`
  expectations.
- Typecheck and `git diff --check` pass. The documentation-only correction does
  not invalidate accepted task `3.3` evidence.
- Unrelated `.gitignore` and OpenSpec changes were not scored.

### Gate assessment

The bounded correction resolves the sole Round 8 P1 without regressing accepted
Wave 3 work. Task `3.4` passes.

REVIEW_ACTION=PASS
CONSENSUS_STATUS=PASS
