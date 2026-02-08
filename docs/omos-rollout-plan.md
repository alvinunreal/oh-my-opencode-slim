# /omos + Scoring V2 Rollout Plan (After PR Bugfixes)

This document captures the agreed roadmap for:
- Scoring Engine V2 (OmO-style core)
- Dynamic selection precedence
- Manual per-agent menu (`primary + 3 fallbacks`)
- OpenCode direct editing via `/omos`
- Shadow rollout and safe promotion

## Scope

- Keep current dynamic selection and installer behavior intact.
- Add a safe editing path for all 6 agents:
  - `orchestrator`
  - `oracle`
  - `designer`
  - `explorer`
  - `librarian`
  - `fixer`
- Each agent must support:
  - `primary`
  - `fallback1`
  - `fallback2`
  - `fallback3`

## Important sequencing

Before implementing `/omos`, we first fix the bugs in the current PR branch.

Reason:
- avoid stacking unstable changes
- keep review scope clear
- reduce regression risk in config/runtime paths

## Architecture decision

Use a hybrid `/omos` approach:

1. `/omos` command entry in OpenCode via command file.
2. Backed by a plugin tool (`omos_preferences`) that performs validated config mutations.

Why this design:
- best UX (works from OpenCode directly)
- safe writes (schema validation + atomic updates)
- no dependence on unsupported plugin-native slash registration

## 5-Part roadmap (functional)

## Part 1 - Scoring Engine V2

Goal: port OmO-style scoring into a modular engine (no monolith).

Deliverables:
- Extract scoring into dedicated modules (features, weights, resolver, explain output).
- Inputs: catalog + external signals (Artificial Analysis/OpenRouter).
- Outputs: `totalScore` + `scoreBreakdown` per candidate.
- Add feature flag: `scoringEngineVersion = v1 | v2-shadow | v2`.
- Designer output rule in V2:
  - `outputLimit >= 64000`: no output bonus
  - `outputLimit < 64000`: `-10` output penalty
- Canonical model-key normalization for signal matching:
  - lowercase
  - remove provider prefix (everything before first `/`)
  - remove `TEE` and `FP*` tokens
  - normalize spaces/underscores/slashes into hyphen aliases

Acceptance criteria:
- Deterministic scores for equal input.
- Explain output available for debugging/tests.
- Fast rollback to V1 via flag.

## Part 2 - Precedence pipeline

Goal: enforce one deterministic resolution order.

Resolution order:
1. OpenCode direct override
2. Manual user plan (`primary + 3`)
3. Pinned model (optional)
4. Dynamic recommendation
5. Provider fallback policy
6. System default

Deliverables:
- Central resolver used by planner and `/omos`.
- Provenance metadata in decisions (which layer won).
- Compile result to runtime format:
  - `agents.*.model`
  - `fallback.chains.*`

Acceptance criteria:
- Same layered inputs always resolve identically.
- Winning source is visible in diagnostics.

## Part 3 - Manual menu

Goal: first-class installer menu for all 6 agents.

Deliverables:
- Installer mode selector: `Auto / Hybrid / Manual`.
- In Manual mode per agent:
  - `primary`
  - `fallback1`
  - `fallback2`
  - `fallback3`
- Suggestion list from Scoring V2.
- Inline validation:
  - exact 6 agents
  - exact `1 + 3`
  - `provider/model` format
  - toolcall capability checks where required

Acceptance criteria:
- Complete setup without raw JSON edits.
- Invalid config blocked before apply.

## Part 4 - OpenCode direct editing (`/omos`)

Goal: mutate model config from OpenCode session directly.

Deliverables:
- `/omos` command entry (command file) + plugin tool backend (`omos_preferences`).
- Operations:
  - `show`
  - `score-plan`
  - `plan`
  - `apply`
  - `reset-agent`
- Atomic write + backup + schema validation.
- Explicit confirm-before-apply.
- Post-apply hint: restart/new session required.

### `/omos` score visibility (manual editing)

Use `score-plan` before applying a manual plan to inspect score output per agent/model.

Recommended flow:

1. `show` - inspect effective + target plan.
2. `score-plan` - evaluate your manual candidates with `engine=v1|v2-shadow|v2`.
3. `plan` - generate diff preview and `diffHash` for the target config.
4. `apply` - run with `confirm=true` (and optional `expectedDiffHash` to guard stale plans).
5. Optional: set `balanceProviderUsage=true` in `plan`/`apply` payloads to keep distribution more even across enabled providers when score gaps are within tolerance.

Copy/paste example suite:
```bash
/omos_preferences '{"operation":"show","target":"auto"}'

# Use a full 6-agent plan object with primary + fallback1 + fallback2 + fallback3.
/omos_preferences '{"operation":"score-plan","target":"auto","engine":"v2","plan":<PLAN_JSON>}'

# Save diffHash from this output.
/omos_preferences '{"operation":"plan","target":"auto","plan":<PLAN_JSON>}'

# Apply the exact same plan (with confirm=true and optional expectedDiffHash guard).
/omos_preferences '{"operation":"apply","target":"auto","plan":<PLAN_JSON>,"expectedDiffHash":"<DIFF_HASH>","confirm":true}'
```

`score-plan` output includes:

- `totalScore` per candidate model.
- Breakdown fields:
  - V1: `baseScore`, `externalSignalBoost`
  - V2: weighted feature breakdown
  - V2 shadow: V1 score plus `shadowV2Score`

Acceptance criteria:
- End-to-end `/omos` editing works without CLI roundtrip.
- Writes are safe, validated, recoverable.

## Part 5 - Test + rollout

Goal: ship safely with measurable confidence.

Deliverables:
- Shadow mode (`v2-shadow`): calculate V1 + V2, apply V1, log diff.
- Test coverage:
  - score determinism
  - chain invariants (no duplicates, always `1 + 3` in manual)
  - migration/backward compatibility
  - runtime failover order
  - json/jsonc + backup/recovery
- Promotion gates and rollback playbook.

Acceptance criteria:
- Divergence and failure metrics within thresholds.
- One-step rollback via feature flag.

## 3 PR steps (delivery packaging)

## PR1 - Scoring V2 + resolver foundation

Goal: land Part 1 + Part 2 foundations behind flags.

Deliverables:
- Scoring engine modules (OmO-style core) + score breakdown.
- Precedence resolver with provenance.
- V2 shadow mode plumbing (no default switch yet).
- Regression and determinism tests.

Non-goals:
- no user-facing manual menu yet
- no `/omos` UX yet

## PR2 - Manual menu + `/omos` backend

Goal: land Part 3 + backend of Part 4.

Deliverables:
- Installer `Auto / Hybrid / Manual` with 6-agent `1 + 3` flow.
- Add validated mutator operations (`show/plan/apply/reset-agent`).
- Atomic write + backup + schema checks.
- Compile to runtime config (`agents.*.model`, `fallback.chains.*`).

## PR3 - `/omos` UX + hardening + rollout gates

Goal: finish Part 4 + Part 5 and promote safely.

Deliverables:
- `/omos` command file install + tool exposure in plugin.
- Confirm-before-apply UX with diff preview.
- Conflict handling (global vs project precedence).
- Shadow metrics + promotion/rollback criteria in docs.
- Final integration suite and release checklist.

PR3 implementation details:
- Installer writes `/omos` command entry to:
  - `~/.config/opencode/commands/omos.md`
- Command uses `omos_preferences` backend with explicit operations:
  - `show`
  - `plan`
  - `apply`
  - `reset-agent`
- `plan` returns a per-agent diff plus `diffHash`.
- `apply` requires `confirm=true`; optional `expectedDiffHash` blocks stale apply.
- `target` selection for write path:
  - `auto` (default): project config if present, else global
  - `project`: `.opencode/oh-my-opencode-slim.json(.jsonc)`
  - `global`: `~/.config/opencode/oh-my-opencode-slim.json(.jsonc)`
- If writing global while project config exists, operation returns precedence warning.

Shadow rollout metrics (v2-shadow):
- Top-1 divergence rate (`v1TopModel !== v2TopModel`) tracked per agent.
- Fallback depth delta (did v2 require deeper fallback than v1).
- Runtime timeout/failover rate by agent and model provider.
- Manual override churn (how often users replace suggested primaries).

Promotion gates:
- Keep `v2-shadow` until all hold for >= 7 days:
  - top-1 divergence <= 25% for orchestrator/oracle combined
  - no increase in failover timeout rate vs v1 baseline
  - no regression in config apply success rate
- Promote to `v2` by flipping `scoringEngineVersion`.
- Rollback to `v1` is one flag change.

Release checklist:
- `/omos` command file installed by installer.
- `show -> plan -> apply` flow verified in fresh session.
- `reset-agent` verified for at least one agent.
- Global/project precedence warning verified.
- Backup file (`.bak`) created on apply.
- Targeted tests and `check:ci` pass.

## Validation checklist

- Config remains loadable after apply.
- Runtime fallback order is preserved (`primary -> fb1 -> fb2 -> fb3`).
- No duplicate model IDs per agent chain.
- Toolcall-required agents cannot be assigned non-toolcall models when metadata is available.
- Existing dynamic planner and install path continue to work unchanged.

## OpenCode direct note

- We use `/omos` via command file + plugin tool backend for current compatibility.
- If OpenCode later supports plugin-native slash registration, we can migrate `/omos` to native command wiring.

## Out of scope (for now)

- Native plugin-registered slash command support (if OpenCode adds this later, we can migrate).
