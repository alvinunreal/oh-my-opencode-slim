---
name: deepwork
description: Tier-2 initiative planning and coordination protocol for consequential, high-stakes, or long-horizon work. Surfaces assumptions, prepares the plan and the bounded Reviewer review packet, coordinates loop-engineering delivery units under the parent/orchestrator, and records the durable review log. Use for single-unit or long-horizon Tier-2 work, and for long-horizon Tier-1 coordination without Tier-2 gates.
---

# Deepwork

`/deepwork` is the Tier-2 initiative planning and coordination protocol.
The parent/orchestrator is the sole lifecycle controller: it owns tier
selection, dispatch, review, proof, and acceptance. `/deepwork` prepares and
coordinates; it does not own the lifecycle, does not run reviews itself, and
does not set an independent loop policy. `/deepwork` is a user-entry adapter,
never a callable procedure.

Do not infer deepwork merely because a task touches multiple files. Do not use
it for trivial edits, quick docs changes, simple bug fixes, or routine bounded
features.

## When To Use

- **Tier 2 (single-unit or long-horizon):** consequential, high-stakes, or
  irreversible work. Surface assumptions, prepare a bounded plan `@reviewer`
  review, obtain explicit user authorisation, coordinate `loop-engineering`
  delivery units, run the integrated proof, and pass one final `@oracle` gate.
- **Long-horizon Tier 1:** may use `/deepwork` for coordination only, without
  the Tier-2 plan review, user authorisation, or Oracle gate.

Risk and horizon are separate axes. Risk sets the tier; horizon sets the
coordination mode. Splitting a Tier-2 initiative into multiple delivery units
must not downgrade risk: every unit remains Tier 2.

## Artifacts

Resolve and state these values before writing:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PLAN_DIR` | `.slim/plans/<descriptive-slug>/` | Per-initiative directory. |
| `PLAN_FILE` | `$PLAN_DIR/PLAN.md` | Implementation plan. |
| `REVIEW_LOG` | `$PLAN_DIR/REVIEW-LOG.md` | Durable record of decisions and review. |

The descriptive slug is human-chosen, lowercase hyphenated, and unique within
`.slim/plans/`. Resolve `PLAN_DIR`, `PLAN_FILE`, and `REVIEW_LOG` to canonical
absolute paths before use.

Before writing any artifact, inspect `.gitignore` and `.ignore` and add only
missing entries (no duplicates):

```gitignore
# .gitignore
.slim/plans/
```

```gitignore
# .ignore
!.slim/plans/
!.slim/plans/**
```

State to the user that plan artifacts are git-ignored. Use only the
`.slim/plans/<initiative>/` paths above; do not write to `.slim/deepwork/` or
any legacy artifact root.

## Plan Structure

Run `/verification-planning` to author the evidence/proof specification; it
chooses the executable proof command, written into the plan's `## Proof`. Do
not author a proof command here, and do not accept a fallback.

Write `PLAN_FILE` with:

```markdown
---
plan_id: <descriptive-slug>
status: draft
review_log: REVIEW-LOG.md
supersedes: none
---

# Plan: <task>

## Plan Chain
- Review log: [REVIEW-LOG.md](REVIEW-LOG.md)
- Predecessor: none
- Successor: none

## Goal
## Approach
## Key Decisions And Trade-offs
## Assumptions
## Risks And Open Questions
## Out Of Scope
## Proof
<executable proof command chosen by /verification-planning>
```

The front matter and Plan Chain are navigational metadata; the plan body and
`## Proof` remain authoritative.

Initialise `REVIEW_LOG` with the confirmed Assumptions Ledger and resolved
tunables.

## Plan Review (Tier 2 Only)

Reviews are prompt-level protocols enforced by the parent/orchestrator; there
is no runtime enforcement. The parent invokes reviews and arbitrates findings;
`/deepwork` supplies factual packets and records outcomes.

Prepare a bounded, read-only `@reviewer` review with `review_mode=plan` of
`PLAN_FILE` and `REVIEW_LOG`. The parent invokes the review; `/deepwork`
supplies the factual handoff packet: an inline evidence brief (`Local Code
Facts`, `External Doc Facts`, `Unresolved Uncertainties`) populated from the
confirmed Assumptions Ledger, plus the factual task requirements, the plan,
surrounding context, and available validation evidence. The packet must not
contain author self-assessment, persuasive rationale, or prior reviewer
conclusions.

`@reviewer` returns exactly one structured verdict: `APPROVED` or `REVISE`. If
the verdict is absent, malformed, or missing, fail closed: do not treat it as
approval, do not proceed, and record the failure in `REVIEW_LOG`. Reinvoke only
for transport failure (within the same round), not to seek a different
substantive verdict.

Bound the loop at five plan rounds. Each round begins with the revised
`PLAN_FILE` and the initial evidence packet without prior reviewer conclusions.
The reviewer forms its independent initial assessment before inspecting
`REVIEW_LOG`; only then may it read the review log to verify prior-finding
disposition. It must not inherit a previous verdict.

Plan review is pre-implementation: the deterministic proof has not run. It
evaluates the proposal, assumptions, and evidence path for adequacy, and must
not require the post-implementation proof to pass before plan approval.

The parent is the arbiter: on `REVISE`, assess each finding, revise `PLAN_FILE`
where warranted, and append accepted changes and reasoned rejections to
`REVIEW_LOG`. Accept only on a valid `APPROVED`. Stop when approved or after
five rounds. Record the actual reviewer model in `REVIEW_LOG` only if
observable; model routing is owned by the parent and plugin, not by this skill.

No implementation begins until the plan is approved and the user explicitly
authorises it.

## Delivery

After plan approval and user authorisation, the parent dispatches
`loop-engineering` delivery units. `/deepwork` coordinates the sequence and
records milestones; it does not dispatch units or declare them complete. Do not
spin up a second retry controller; `loop-engineering` owns the per-unit
delivery loop.

A delivery unit packet carries:

- delivery unit ID and plan version;
- scope, exclusions, and dependencies;
- proof commands and prerequisites;
- Tier-2 authority, if applicable;
- attempt count and any prior failure;
- factual context: local evidence, external sources (URL + ref + retrieval
  time), and stated uncertainty.

Delivery order:

1. Fixer delivery;
2. planned proof;
3. one implementation `@reviewer` review (`review_mode=implementation`);
4. at most two repairs with affected proof;
5. parent acceptance.

Proof runs before the implementation review. The implementation review
evaluates the candidate spec, diff, and executed evidence after the proof
runs; `loop-engineering` owns the per-unit implementation review. A review
cannot waive a failed proof or gate.

### Per-unit completion

- Each delivery unit receives exactly one implementation `@reviewer` review
  covering the spec, the diff, and proof output.
- If the implementation `@reviewer` verdict is absent, malformed, or missing,
  fail closed: do not declare the unit complete. Record the failure in
  `REVIEW_LOG` and either reinvoke for transport failure or replan.
- The plan-specific deterministic proof and project-specific gates apply to the
  exact candidate revision. A review cannot waive a failed proof or gate.
- All blocking findings require a documented disposition. Accepted repairs
  require affected validation to pass.
- `APPROVED` or zero findings is not evidence of correctness or deployment
  evidence.
- A unit is complete when: the `@reviewer` review has run, all blocking
  findings have a documented disposition, accepted repairs pass affected
  validation, and the exact candidate revision satisfies the plan-specific
  proof and gates. The parent validates unit completion; no unit is
  self-declared complete.
- Allow two repair attempts per delivery unit. After exhaustion, fail closed
  and replan: stop, record the failure in `REVIEW_LOG`, and revise the plan or
  scope with the user.

### Risk precedence and replan triggers

When multiple problems compete, resolve in this order:

1. **Failed proof or gate:** blocking regardless of review verdict; the unit
   is not complete.
2. **Blocking reviewer finding:** requires documented disposition and repair
   before the unit can complete.
3. **Repair exhaustion:** two failed repair attempts on the same unit trigger
   replan. Stop, record the exhaustion in `REVIEW_LOG`, and revise the plan or
   scope with the user before dispatching further work.
4. **Plan-round exhaustion:** five plan-review rounds without approval trigger
   replan. Stop, present unresolved points to the user, and revise the plan or
   scope before retrying.

Do not continue delivery while a blocking proof failure, unresolved blocking
finding, or repair exhaustion is unrecorded in `REVIEW_LOG`.

### Tier-2 initiative completion

A Tier-2 initiative is complete only when all delivery units are
parent-validated as complete and the single `@oracle` judgment gate has run.
Unit completion does not imply initiative completion. The Oracle gate is the
final Tier-2 gate; repairs after Oracle findings receive parent validation, not
a second Oracle opinion.

### Worktree Policy

Tier 2 uses `/worktrees` before parallel or write-conflicting delivery units.
Otherwise it operates in the main checkout only after a clean-tree check. Tier
0/1 never create a worktree solely because of file count.

## Oracle Gate (Tier 2 Only)

After all delivery units are parent-validated as complete (proof passed,
deterministic gates satisfied, blocking findings resolved), the parent runs
exactly one `@oracle` judgment gate for the initiative. Provide the plan, the
diff, the proof result, and the review findings. Record its verdict in
`REVIEW_LOG`. Repairs after Oracle findings receive parent validation, not a
second Oracle opinion. The initiative is not complete until the Oracle gate has
run and its verdict is recorded.

There is no per-phase Oracle. The Oracle gate runs once, at initiative
completion, under the parent. Plan review and implementation review assess
distinct objects (the plan vs the delivered diff); neither is a per-phase gate
and they do not chain into per-phase gates.

## Long-Horizon Coordination (Tier 1)

For long-horizon Tier-1 coordination, `/deepwork` tracks dependencies,
milestones, and progress/resumption in `PLAN_FILE` and `REVIEW_LOG`. No
`.slim/deepwork/` directory, no Tier-2 plan review, no user authorisation gate,
no Oracle gate, and no second retry controller. Delivery units still use
`loop-engineering` under the parent.

## Durable Log

`REVIEW_LOG` is the durable record of the initiative. Record each milestone as
it occurs, not retrospectively:

- **Plan approval:** the `@reviewer` plan-review verdict, round count, and
  accepted/rejected findings.
- **User authorisation:** that the user explicitly authorised implementation.
- **Unit completion:** per unit, the `@reviewer` implementation-review
  verdict, proof result, blocking-finding dispositions, and parent validation
  outcome.
- **Repair exhaustion:** the unit, attempt count, and replan decision.
- **Oracle gate:** the `@oracle` verdict, findings, and any post-Oracle parent
  validation.
- **Initiative completion:** confirmation that all units are complete and the
  Oracle gate has run (Tier 2 only).

Do not declare a milestone reached in `REVIEW_LOG` before it has actually
occurred. A missing milestone record means the milestone has not been met.

## Scheduler Discipline

When deepwork is active, the orchestrator must manage the work as a scheduler,
not as the default implementation worker. Use the scheduler model throughout:

- record task/session IDs and ownership boundaries;
- wait for hook-driven background completion before consuming background
  results;
- avoid blocking the Orchestrator lane while background jobs run; if no
  independent work remains, stop briefly and let the completion event resume
  the workflow;
- do not advance to the next phase while relevant jobs are running or terminal
  results are unreconciled.

## Designer Handoff Guardrail

When a deepwork phase includes `@designer`, treat the delivered UI/UX as
accepted design intent for later phases. Record any important design decisions
in `PLAN_FILE` before continuing.

After designer work:

- preserve layout, rhythm, hierarchy, motion, spacing, color, affordances,
  responsiveness, and component feel;
- review and improve user-facing copy with grounded, normal wording, but do not
  change visual structure or interaction intent;
- route follow-up visual, responsive, motion, hierarchy, polish, or
  component-feel changes back to `@designer`;
- use `@fixer` only for bounded mechanical follow-up that preserves the design
  exactly, such as wiring, tests, type fixes, or non-visual behavior changes;
- if design intent must change, record why in `PLAN_FILE` before changing it.

## Human Gates

- The user confirms the Assumptions Ledger.
- The user authorises the plan and chooses whether to proceed.
- The user approves the final reviewed diff before any commit.

## Non-Negotiable Rules

- No code during plan review.
- `@reviewer` is read-only.
- Bound review and repair loops; do not delegate indefinitely.
- The implementing model never treats its own output as verified.
- Do not commit, push, release, or mutate GitHub without explicit user
  approval.
- `/deepwork` coordinates under the parent; it does not own the lifecycle, run
  reviews, dispatch units, or set an independent loop policy.
