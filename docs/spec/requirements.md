# Requirements: SDD + TDD + Grill Enhancement for slim

Source: 47-round grill session, 2026-05-23.
Scope: fork-local enhancements on top of upstream `oh-my-opencode-slim`.
Audience: cold-session AI agents resuming work without conversation history.

---

## REQ-001: Workflow layering

The fork MUST keep two layers separate:

- **Generic layer** (this fork): SDD workflow, TDD orchestration, review gates, memory persistence, model role split, PR/worktree/direct routing.
- **Domain layer** (external plugins like `ttd-dev-agent`, `denox-*`): commit conventions, branch policy, CI, deployment, post-deploy regression, infra ops.

The generic layer MAY call into the domain layer via skill auto-discovery. The generic layer MUST NOT contain domain-specific routing logic.

## REQ-002: Spec triad (SDD)

Every non-trivial task MUST produce three artifacts in the target project's `docs/spec/` directory:

- `requirements.md` — what to build and why
- `design.md` — how to build it
- `trace.md` — pure ID mapping (`REQ-* → DES-* → TASK-*`)

Both `requirements.md` and `design.md` are concise and self-contained for cold-agent handoff. Background and rejected alternatives MAY live in memex (project-tagged) instead of bloating the triad.

## REQ-003: Grill-then-spec order

For any new task:

1. Grill the user's idea first (agent self-interrogates: list assumptions, risks, self-answerable vs human-only questions; answer the self-answerable ones via `@explorer`/`@librarian`).
2. Produce `requirements.md` from the grill output.
3. Produce `design.md` from `requirements.md`.
4. Generate `trace.md` before execution.

If grill cannot converge, halt. Do not enter execution. Convergence criteria: (mechanical) all three files exist with required sections; (human) explicit "go" from user.

## REQ-004: Spec authorship and amendment

- The grill agent owns initial spec authorship.
- During execution, any agent MAY amend `requirements.md` when it discovers genuine gaps.
- Any amendment MUST trigger affected-only re-run: only the impacted `design.md` sections and `tasks` are regenerated, not the full pipeline. This requires `trace.md` to stay accurate.

## REQ-005: Trace maintenance

`trace.md` is a flat ID mapping (no rationale).

- IDs are assigned **post-hoc** by an agent scanning the triad, not pre-allocated during writing.
- Trace regeneration is **automatic**, triggered by the orchestrator before any execution phase.
- If trace is stale at execution entry, orchestrator re-runs trace generation, then proceeds without user confirmation.
- Trace exists so cold sessions can follow established work without conversation history. It is not a human-review artifact.

## REQ-006: Model role split

- **Opus 4.7** runs as `orchestrator`, `oracle`, and `council` synthesizer.
- **GPT-5.5** runs as `librarian`, `explorer`, `designer`, `fixer`.
- **Gemini Pro** appears only as a `council` councillor (edge participation).

Role enforcement:

- Opus MUST NOT write implementation code directly. Delegate to `@fixer`.
- GPT fixer MAY make small local decisions when spec is silent. Architectural divergence is caught at output review.

## REQ-007: Two review gates

Replace the natural 4-point review schedule with 2 consolidated gates to control Opus cost:

- **Entry review** — fires after trace regeneration or on cold-session handoff. Confirms the triad and trace are mutually consistent before execution begins.
- **Output review** — fires after subtask batch completion, before commit. Reviews the accumulated diff against trace anchors.

If output review finds divergence: GPT fixer redoes the work with brief guidance from Opus. Opus does not edit code directly.

## REQ-008: Persistent lessons via memex

- `oracle` is the sole memex **writer**. Writes occur only at the two review gates.
- `orchestrator` is the memex **reader**: before launching each subtask, it calls `recall_memories` with the subtask topic + project tag and injects the top results into the subtask prompt.
- Two write categories: `pitfall` (divergence found at review) and `pattern` (good practice discovered).
- Project scoping: oracle infers project identity from git remote / repo root / context. Memories carry project tag when inferable, global tag when cross-project.

## REQ-009: TDD execution discipline

- Default: strict TDD (red → green → refactor), enforced by **inlined distilled rules** in the orchestrator prompt (see REQ-010 for source/rationale).
- The discipline is held by `orchestrator` (Opus), not by `fixer`. Opus decomposes a TDD cycle into three narrow subtasks (write failing test → implement to green → refactor).
- Exemption categories (orchestrator decides automatically):
  - UI / visual / exploratory prototype
  - Test infrastructure absent (no test runner, no test directory)
- If test infrastructure is missing, run a one-shot "build infra" subtask first, record the setup in `design.md` under a `Test infrastructure` section, then return to TDD.

## REQ-010: Inlined discipline (distilled from superpowers)

This fork does NOT depend on the `superpowers` plugin at runtime. Rationale: the `superpowers` skill style (long checklists, red-flag tables, 9-step procedures) is optimized for weaker models and becomes redundant or token-wasteful on Opus 4.7, which already exhibits strong native discipline.

Instead, the high-value subset of `superpowers` is distilled into compact rules embedded directly in the orchestrator prompt (`customAppendPrompt`):

- **TDD**: red→green→refactor cycle, subtask decomposition, exemption gates (covers REQ-009)
- **Systematic debugging**: hypothesis-first, narrow-the-scope, no fix-by-guessing
- **Verification before completion**: explicit checks before declaring done; no self-congratulatory "completed" without evidence

Skills explicitly NOT distilled (handled by slim or our own design):

- `brainstorming` — replaced by our grill workflow (REQ-003)
- `subagent-driven-development` — covered by slim's orchestrator + subtask
- `using-git-worktrees` — operational, handled by REQ-011 routing
- `writing-plans` / `executing-plans` — covered by SDD triad (REQ-002)
- `requesting-code-review` / `receiving-code-review` — covered by review gates (REQ-007)

Distilled rules MUST stay under 200 lines total when embedded. Periodically re-check upstream `superpowers` for new high-value skills worth distilling, but pull rules manually rather than runtime-loading the plugin.

## REQ-011: Routing for change strategy

Orchestrator auto-selects one of three routes per task:

- **Worktree** when working tree is dirty (`git status` shows uncommitted changes).
- **PR-based** when tree is clean AND task touches >1 file OR >50 lines.
- **Direct commit** when tree is clean AND task touches 1 file AND <50 lines AND no spec section is linked.

Worktree creation uses `superpowers:using-git-worktrees`. PR creation and branch naming are delegated to domain-layer skills.

## REQ-012: Cold-session self-containment

A fresh agent session resuming work MUST be able to proceed using only:

- the triad (`requirements.md`, `design.md`, `trace.md`)
- memex recall (project-tagged)
- the codebase itself

When the cold agent cannot reach high-confidence inference from the above, it MUST pause and ask the user rather than guess. Acceptable interruption frequency: 1-2 questions per cold handoff per project.

## REQ-013: Trial window and success metric

Self-imposed evaluation window: 2 weeks from first real task.

Success criteria:

- Token usage ≥30% lower than baseline `oh-my-openagent` workflow on comparable tasks, OR
- Subjective workflow throughput improved without token regression.

If neither holds after 2 weeks, revert.

## REQ-014: Spec change proposals as deltas, not in-place edits

After the initial triad (`requirements.md` + `design.md` + `trace.md`) exists, every subsequent grill / spec evolution MUST produce a **change proposal** in `docs/spec/changes/<slug>/` containing `delta-requirements.md` and `delta-design.md`, rather than editing the main triad files directly.

The delta files are reviewed by `@oracle` at the output review gate. Only after approval are the deltas merged into the main triad via the `spec_merge` tool.

Rationale: in-place edits lose the "why we changed" audit trail. A delta + archive flow preserves a forever-grep-able history of every spec change, with the decision context attached.

Inspired by OpenSpec (`openspec/changes/<feat>/`) but adapted to this fork's existing triad layout.

Source: OpenSpec evaluation, 2026-05-24.

## REQ-015: Archive merged changes

When a spec_merge succeeds, the change directory MUST be moved (not copied) from `docs/spec/changes/<slug>/` to `docs/spec/archive/YYYY-MM-DD-<slug>/`. The date is the merge date in the local timezone.

Archive entries are read-only by convention; no tool re-opens them for edit. `trace.md` does not include archived changes — it tracks only the current state of the main triad.

Rationale: keeps `changes/` lean (only in-flight work), preserves history under predictable paths for cross-session recall and memex references.

Source: OpenSpec evaluation, 2026-05-24.

## Out of scope (deferred to domain layer / future work)

- Commit message format
- Branch naming convention
- PR description template
- CI configuration
- Deployment pipeline (Ansible / containers / ingress)
- Post-deployment business regression
- Cross-project priority scheduling
- Rollback procedure
- Observability / alerting

## REQ-016: Installation guide must front-load the fork-vs-upstream verification gate

Blind installs by an LLM agent will often land on the upstream NPM package
of the same name (`oh-my-opencode-slim`) and silently miss the fork's
SDD/TDD code. The installation guide MUST give the agent a single,
mechanical verification step (grep `spec_propose` in `dist/index.js`)
that decides whether the active plugin source is the fork or upstream,
and a local-checkout fallback to use when the GitHub plugin spec fails
with `git dep preparation failed`.

The verification step MUST appear before any preset / memex / spec-dir
configuration, because none of those have meaning if the loaded plugin
is upstream.

## REQ-017: Preset documentation must specify all council edges, not only the median

The fork's council agent is a three-edge structure (alpha / beta / gamma).
The installation guide currently shows only the top-level `council.model`
and leaves `gamma` implicit, which causes downstream presets to ship a
two-edge council that silently falls back at runtime. The guide MUST
include a concrete `council.gamma` example (with a real model id) and
state that omitting `gamma` is a configuration error, not a default.

## REQ-018: Workflow documentation must define when the agent may stop to ask the user

Without an explicit interaction discipline, the orchestrator and grill
skill tend to escalate decisions the agent could make itself. The
installation guide MUST define a short, enumerated list of cases that
warrant a human-decision stop, and state that everything outside that
list is the agent's call. The grill skill's phase-4 anti-patterns MUST
be hardened to refuse escalations that grep / file-read / doc-fetch
could have resolved in phase 3.
