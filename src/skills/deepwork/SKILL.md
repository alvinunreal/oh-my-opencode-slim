---
name: deepwork
description: High-cost orchestrator workflow for large, high-risk, multi-phase coding efforts with meaningful dependencies and review gates. Do not activate for routine multi-file changes.
---

# Deepwork

Deepwork is an orchestrator workflow for heavy coding sessions. Use it only
when the work is clearly large or high-risk: multiple dependent phases,
cross-cutting architectural change, unsafe-to-partially-ship migration, or
sustained coordination across several specialist lanes.

Do not infer Deepwork merely because a task touches multiple files. Do not use
it for trivial edits, quick docs changes, simple bug fixes, or routine bounded
features.

## Core Contract

When deepwork is active, the orchestrator must manage the work as a scheduler,
not as the default implementation worker.

Required behavior:

- before planning, delegation, or creating a deepwork state file, inspect the
  existing `.gitignore` and `.ignore`; add only missing entries, without
  duplicates, so `.gitignore` contains `.slim/deepwork/` and `.ignore` contains
  `!.slim/deepwork/` and `!.slim/deepwork/**`;
- keep OpenCode todos aligned with the active deepwork phase;
- create and maintain a local markdown progress file under `.slim/deepwork/`;
- save code/doc deliverables to project paths (e.g. `src/`, `docs/`); reserve
  `.slim/deepwork/` strictly for progress files;
- write valuable research findings into that file as confirmed research context
  when they are received and reconciled;
- draft a plan before implementation;
- create a phased implementation/delegation plan;
- before dispatch, choose a small number of coherent implementation phases from
  the work's dependencies and natural delivery boundaries; do not split work
  merely to reduce an Oracle review's scope;
- before execution, show the user a compact overview containing only phase
  titles and order, each delegated specialist with its ownership/scope, and the
  total Oracle reviews with the gate after each phase and a short reason for it;
- before each implementation phase, decide the execution path: what can run in
  parallel, what must be sequential, which specialists to delegate to, and
  whether to split the same agent into multiple bounded lanes;
- after each planned phase, validate and update the deepwork file, then ask
  `@oracle` to review the phase result before continuing;
- before an Oracle review, add relevant confirmed research findings and file
  references to the deepwork file so Oracle can assess the decision or risk from
  accepted context instead of redoing discovery;
- triage and batch material actionable Oracle findings into one bounded
  remediation pass, then validate it with focused evidence; request a follow-up
  Oracle review only if that remediation changes the reviewed decision/risk or
  the original concern cannot otherwise be verified;
- when a phase includes `@designer`, preserve designer intent across later
  phases. Use `@fixer` only for mechanical follow-up that does not alter the
  UI/UX;
- finish with final validation and a concise summary.

## Planned Phase Reviews

Oracle reviews are automatic gates between the planned implementation phases.
Before dispatch, decide the phases from the task itself: its dependencies,
integration boundaries, and meaningful delivery points. Record the phase order,
the total review count, the review after each phase, and a short reason for each
gate in the deepwork file and compact user overview.

Avoid micro-phases created only to make reviews smaller or cheaper. Larger,
complex tasks can have broader phases, broader patches, and correspondingly
broader phase reviews. The goal is a sensible number of predictable review
gates, not the smallest possible review scope. Never add an extra Oracle review
merely to re-confirm a mechanical fixer change.

## Designer Handoff Guardrail

When a deepwork phase includes `@designer`, treat the delivered UI/UX as
accepted design intent for later phases. Record any important design decisions in
the deepwork file before continuing.

After designer work:

- preserve layout, rhythm, hierarchy, motion, spacing, color, affordances,
  responsiveness, and component feel;
- review and improve user-facing copy with grounded, normal wording, but do not
  change visual structure or interaction intent;
- route follow-up visual, responsive, motion, hierarchy, polish, or
  component-feel changes back to `@designer`;
- use `@fixer` only for bounded mechanical follow-up that preserves the design
  exactly, such as wiring, tests, type fixes, or non-visual behavior changes;
- if design intent must change, record why in the deepwork file before changing
  it.

## Deepwork File

Create a task-specific file such as:

```text
.slim/deepwork/<short-task-slug>.md
```

Before creating this file—and before planning or delegation—inspect the existing
`.gitignore` and `.ignore`. Add only missing entries and do not add duplicates:

```gitignore
# .gitignore
.slim/deepwork/
```

```gitignore
# .ignore
!.slim/deepwork/
!.slim/deepwork/**
```

These rules keep deepwork state git-local while allowing OpenCode to read it.

Do not follow a rigid template. Choose whatever markdown structure best fits the
work. The file only needs to remain useful as persistent session state and should
capture, as applicable:

- current goal and understanding;
- researched, factual context from `@librarian` to avoid oracle doing its own
  research;
- plan drafts, Oracle review budget/gates, and review notes;
- implementation phases and status;
- validation results;
- unresolved questions, blockers, and follow-ups.

Update this file after major decisions, valuable specialist research, reviews,
phase completions, validation results, and scope changes.
When `@librarian` docs, code reads, or external references produce useful
information, reconcile the result and record the accepted findings here so later
planning and reviews share the same context instead of rediscovering it.
Don't put actual contents of local files, reference them by path only.

## Scheduler Discipline

Use the scheduler model throughout:

- follow Orchestrator delegations rules
- record task/session IDs and ownership boundaries;
- wait for hook-driven background completion before consuming background results;
- avoid blocking Orchestrator lane while background jobs run; if no independent
  work remains, stop briefly and let the completion event resume the workflow;
- do not advance to the next phase while relevant jobs are running or terminal
  results are unreconciled.
