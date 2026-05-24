# Design: SDD + TDD + Grill Enhancement for slim

Source: derived from `requirements.md` (REQ-001..REQ-013).
Scope: fork-local changes to `oh-my-opencode-slim`. No upstream PR planned at
this stage (self-use trial per REQ-013).

This document covers HOW. WHY lives in `requirements.md`.

---

## DES-001: Repository layout for SDD artifacts

Target projects (the projects this fork is *used on*) place SDD artifacts in:

```
<project-root>/docs/spec/
  requirements.md
  design.md
  trace.md
```

This fork itself dogfoods the layout. See current `docs/spec/` contents.

Rationale anchor: REQ-002.

---

## DES-002: Distilled rules location

`docs/spec/distilled-rules.md` (this fork) holds the canonical text of the
inlined discipline rules. The text is loaded at build time and injected into
the orchestrator prompt via `customAppendPrompt`.

Build-time injection (not runtime) means the rules become part of the shipped
prompt and survive offline/sandboxed sessions.

Rationale anchor: REQ-010.

---

## DES-003: Orchestrator prompt assembly

Touched file: `src/agents/orchestrator.ts`.

Add a new function `buildAppendPrompt()` that concatenates:

1. SDD workflow block (DES-004)
2. Routing decision block (DES-006)
3. Distilled discipline rules (loaded from `docs/spec/distilled-rules.md`)
4. memex integration block (DES-007)

The append prompt is passed through the existing `customAppendPrompt`
parameter of `createOrchestratorAgent()`. No change to the base
`buildOrchestratorPrompt()`.

Rationale anchor: REQ-006, REQ-010.

---

## DES-004: SDD workflow block

Inlined into orchestrator append prompt. Pseudocode form:

```
For any non-trivial task:
1. Detect: does <project-root>/docs/spec/requirements.md exist?
   - NO  → enter grill mode (DES-005), produce triad, then continue.
   - YES → run trace freshness check (DES-008). If stale, regenerate trace.
2. Run entry review (REQ-007). Block on divergence.
3. Decompose into tasks linked to DES-* anchors.
4. For each task: route (DES-006), execute (with TDD per distilled rules).
5. Run output review (REQ-007). Block on divergence.
6. memex save via @oracle (DES-007).
```

"Non-trivial" is defined as: any task estimated to touch >1 file OR introduce
new behavior. Trivial tasks (typo fix, single-line tweak) skip SDD and go to
direct-commit route per DES-006.

Rationale anchor: REQ-003, REQ-007.

---

## DES-005: Grill mode

Implementation: a custom slash command `/grill` registered via slim's CLI
extension surface. Source location: `src/cli/commands/grill.ts` (new file).

Workflow:

1. Take user's raw idea as input.
2. Orchestrator (Opus) generates three buckets:
   - **Self-answerable** (delegated to `@explorer` / `@librarian` to resolve)
   - **Human-decision** (asked via existing `/interview` browser UI)
   - **High-risk assumptions** (listed, asked human to confirm/reject)
3. After all buckets resolve, write `requirements.md`.
4. Generate `design.md` from `requirements.md` in the same flow.
5. Generate `trace.md` (DES-008).

Convergence gate: if grill cannot produce a complete triad after 3 rounds of
interview, halt. User must manually re-issue `/grill` with sharper input.

Rationale anchor: REQ-003.

---

## DES-006: Three-route change strategy

Inlined into orchestrator append prompt. Decision tree:

```
git status shows uncommitted changes?
  YES → worktree route
        - create worktree via direct git commands (not superpowers)
        - run task in worktree
        - merge back via PR on completion

  NO  → estimate impact (files_touched, lines_changed, spec_anchored)
    files > 1 OR lines > 50 OR spec_anchored
      YES → PR route
            - feature branch (naming delegated to domain skills)
            - work on branch
            - open PR (description includes REQ-* / DES-* / TASK-* anchors)

      NO  → direct-commit route
            - work on current branch
            - commit with anchor reference if any
```

The orchestrator runs this decision once per task, announces the chosen route
in one line, proceeds.

Rationale anchor: REQ-011.

---

## DES-007: memex integration

memex is mounted as an MCP on the `oracle` agent only (per REQ-008).

Configuration: in `oh-my-opencode-slim.json` user config:

```jsonc
{
  "presets": {
    "<preset-name>": {
      "oracle": { "mcps": ["memex"] }
    }
  }
}
```

Behavior, inlined into orchestrator append prompt:

- **Before each subtask launch** (orchestrator as reader): orchestrator calls
  `recall_memories` with the subtask topic + project tag. Top 3-5 results
  injected into subtask prompt under `## Lessons from past work`.
- **At entry review** (oracle as reader): oracle calls `recall_memories` with
  the triad's title + project tag. No save at this gate.
- **At output review** (oracle as writer): oracle inspects diff vs trace. If
  divergence found, oracle calls `save_memory` with tag `pitfall` + project
  tag. If a noteworthy pattern emerged, tag `pattern` + project tag.

Read/write separation: only `oracle` ever calls `save_memory`. Both
`orchestrator` and `oracle` may call `recall_memories`.

Project tag derivation:
- Prefer git remote URL parsed for `org/repo`.
- Fallback: repo root directory name.
- If neither available (e.g. detached working dir): tag `global`.

Rationale anchor: REQ-008, REQ-012.

---

## DES-008: trace.md generation and freshness

trace.md format (pure ID mapping, no rationale text):

```markdown
# Trace

| REQ | DES | TASK |
|-----|-----|------|
| REQ-001 | DES-003, DES-004 | TASK-001 |
| REQ-002 | DES-001 | — |
...
```

Generation: a built-in tool `trace_regenerate` (new). Source:
`src/tools/trace.ts`. Implementation:

1. Scan `requirements.md` for `## REQ-NNN:` headings.
2. Scan `design.md` for `## DES-NNN:` headings.
3. Scan tasks (slim's todo system) for active TASK-IDs.
4. For each REQ, find DES sections that anchor it (look for
   `Rationale anchor: REQ-NNN` lines, as used in this design document).
5. For each DES, find TASKs that reference it (similar anchor convention).
6. Emit `trace.md` with the mapping table. Overwrite previous file.

Freshness check: a hook on orchestrator startup compares mtime of
`requirements.md` and `design.md` vs `trace.md`. If either source is newer,
mark trace stale and call `trace_regenerate` before any execution phase.

The freshness hook lives in: `src/hooks/trace-freshness/` (new).

Rationale anchor: REQ-004, REQ-005.

---

## DES-009: Model role binding in config

User preset (`~/.config/opencode/oh-my-opencode-slim.json`) for this fork:

```jsonc
{
  "preset": "opus-gpt-mix",
  "presets": {
    "opus-gpt-mix": {
      "orchestrator": { "model": "anthropic/claude-opus-4-7", "skills": ["*"], "mcps": ["*", "!context7"] },
      "oracle":       { "model": "anthropic/claude-opus-4-7", "variant": "high", "skills": [], "mcps": ["memex"] },
      "council":      { "model": "anthropic/claude-opus-4-7" },
      "librarian":    { "model": "openai/gpt-5.5", "variant": "low",  "skills": [], "mcps": ["websearch", "context7", "grep_app"] },
      "explorer":     { "model": "openai/gpt-5.5", "variant": "low",  "skills": [] },
      "designer":     { "model": "openai/gpt-5.5", "variant": "medium", "skills": [] },
      "fixer":        { "model": "openai/gpt-5.5", "variant": "low",  "skills": [] }
    }
  },
  "council": {
    "presets": {
      "default": {
        "alpha":  { "model": "anthropic/claude-opus-4-7" },
        "beta":   { "model": "openai/gpt-5.5" },
        "gamma":  { "model": "google/gemini-3-pro" }
      }
    }
  }
}
```

This config lives outside the fork (it is per-user). The fork ships a
template in `docs/spec/preset-example.jsonc` for reference.

Rationale anchor: REQ-006.

---

## DES-010: Domain-layer handoff

The orchestrator append prompt instructs:

> When the task description matches a skill registered by a domain plugin
> (e.g. `ttd-dev-agent:*`, `denox-*`), invoke that skill via the standard
> Skill mechanism. Do not reimplement domain logic. Domain skills self-judge
> applicability via their own description fields.

No new code in this fork for domain routing. Domain plugins are responsible
for being discoverable.

Rationale anchor: REQ-001.

---

## DES-011: Test infrastructure (for this fork)

slim already uses Bun for tests. Distilled-rules and SDD-workflow logic that
lands in TypeScript modules will get Bun tests at the module boundary:

- `src/tools/trace.ts` → `src/tools/trace.test.ts` (parse + emit)
- `src/hooks/trace-freshness/` → unit tests for staleness detection
- `src/cli/commands/grill.ts` → integration test for grill loop

Run with `bun test`. CI gate: `bun run check:ci && bun test`.

Rationale anchor: REQ-009 (dogfooding TDD on this fork itself).

---

## DES-012: Out-of-scope reminder

This design does NOT cover:

- CI workflows (delegated to domain layer / future)
- Deployment (delegated to domain plugins)
- PR description templates (delegated to domain layer)
- Multi-project priority scheduling (handled by user, not orchestrator)
- Rollback / observability (out of generic-layer scope per REQ-001)

If implementation reveals these are blockers, amend `requirements.md`
(triggers REQ-004 re-run path), not this document directly.

---

## DES-013: Spec delta propose / merge tools

Rationale anchor: REQ-014.

Directory layout for in-flight changes:

```
docs/spec/
├── requirements.md           # main (trunk)
├── design.md                 # main (trunk)
├── trace.md                  # auto-generated, tracks trunk only
├── changes/
│   └── <slug>/
│       ├── proposal.md       # one-paragraph "why this change"
│       ├── delta-requirements.md
│       └── delta-design.md
└── archive/
    └── 2026-05-24-<slug>/    # post-merge resting place (see DES-014)
```

Two tools, both registered alongside `trace_regenerate` in `src/tools/spec/`:

**`spec_propose`** — args: `slug` (kebab-case), `summary` (one line). Behavior:
- Refuse if `docs/spec/requirements.md` does not exist (use plain triad bootstrap instead).
- Refuse if `docs/spec/changes/<slug>/` already exists (slug collision).
- Compute next REQ-ID and DES-ID by scanning trunk + all open `changes/*/delta-*.md`.
- Write three skeleton files with the allocated IDs pre-stamped.

**`spec_merge`** — args: `slug`. Behavior:
- Parse `delta-requirements.md` and `delta-design.md`, extract REQ-* / DES-* sections (heading-anchored, same regex as `extractIds`).
- Append each new section to the corresponding trunk file (never edit existing sections — that requires an explicit `--replace REQ-NNN` flag in a future iteration).
- Refuse if any delta REQ/DES ID already exists in trunk (collision).
- Run `regenerateTrace` after successful merge.
- Return list of merged IDs for the caller (oracle) to log.

Conflict policy: merge is purely additive in v1. Edits to existing REQs/DESs are deferred to a `spec_amend` tool (out of scope for this PR; track as future work).

## DES-014: Archive merged changes

Rationale anchor: REQ-015.

**`spec_archive`** — args: `slug`. Behavior:
- Refuse if `docs/spec/changes/<slug>/` does not exist.
- Refuse if `docs/spec/archive/<YYYY-MM-DD>-<slug>/` already exists (slug-day collision: the caller picks a different slug or merges into existing archive entry).
- Move (not copy) the entire change directory to `docs/spec/archive/<YYYY-MM-DD>-<slug>/` using `fs.renameSync` so the operation is atomic on the same filesystem.
- Date is computed from `new Date()` in the local timezone, formatted `YYYY-MM-DD`.

`spec_archive` MUST be called as the immediate next action after `spec_merge` succeeds. Per the SDD workflow append-prompt, `@oracle` is responsible for invoking both as part of output review.

Archive entries are NOT scanned by `trace-freshness` hook, NOT parsed by `extractIds`, and NOT included in `regenerateTrace` output. They are pure historical record, addressable via path.

## DES-015: Plugin source verification block inserted before Step 5

Rationale anchor: REQ-016.

Insert a new subsection "Step 4.5: Verify Active Plugin Source (Fork-Specific)"
into `docs/installation.md` immediately before the existing Step 5
fork-specific addendum, inside the `<!-- slim-fork-addendum -->` block.

The subsection prescribes a decision tree:

1. Run `opencode plugin install boin/oh-my-opencode-slim`. If it returns
   `git dep preparation failed`, fall back to step 2.
2. Local checkout fallback: clone the fork to
   `~/.config/opencode/plugins/oh-my-opencode-slim-sdd`, `bun install`,
   `bun run build`, then add the absolute path as a string entry in
   the `plugin` array of `~/.config/opencode/opencode.json`.
3. Verification gate (mandatory regardless of which path succeeded):
   `grep -l spec_propose <plugin-dist-path>/dist/index.js` MUST return a
   hit. If it does not, the loaded plugin is upstream, not the fork —
   stop and re-do step 1/2.

The block is kept inside the existing addendum markers so upstream
merges continue to surface it as a single delete.

## DES-016: council.gamma example added to Step 5 preset description

Rationale anchor: REQ-017.

Augment the existing "Variants in the preset" bullet list in Step 5 with
a concrete `council` block example that includes `alpha`, `beta`, and
`gamma`. Use `<alias>/gemini` as the gamma model in the gateway variant
and `google/gemini-3-pro` in the official-providers variant, mirroring
the rest of Step 5's two-path structure.

Add a one-line rationale: "council without gamma silently degrades to a
two-edge debate; the third edge is the disagreement signal, not a
fallback."

## DES-017: Step 8 "Interaction discipline" + grill anti-pattern hardening

Rationale anchor: REQ-018.

Add Step 8 to `docs/installation.md`, inside the addendum markers,
after Step 7. Step 8 contains:

1. A three-item enumeration of valid reasons to stop and ask the user:
   - Genuine human-only judgment (business priority, scope/quality
     tradeoff, taste call the agent cannot derive).
   - Irreversible side effect (destructive git, external API write,
     production deploy, money, messages to other humans).
   - Scope explosion (the task as briefed implies >N files or >M lines
     of change beyond what the user approved; agent must reconfirm
     scope before continuing).
2. A one-line rule: anything outside those three categories is the
   agent's call. Do not stop to confirm routing, model choice, file
   layout, or anything the agent could resolve by reading the code.
3. A pointer back to the grill skill's phase-4 rules for the
   deep-dive case (spec authoring).

Separately, edit `src/skills/grill/SKILL.md` § Anti-patterns to add:

- Self-check before writing any `H-N`: "Could `grep`, a file read, or a
  doc fetch answer this? If yes, it belongs in phase 3, not phase 4."

This is documentation + skill-text only; no runtime code changes.
