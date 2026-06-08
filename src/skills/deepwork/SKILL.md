---
name: deepwork
description: Orchestrator-only workflow for heavy coding sessions, multi-phase implementation, and risky refactors. Use for complex work that needs planning, review gates, and persistent progress tracking.
---

# Deepwork

Deepwork is an orchestrator workflow for heavy coding sessions. Use it when the
work is broad, risky, multi-file, or likely to span several implementation
phases. Do not use it for trivial edits, quick docs changes, or simple bug fixes.

## Core Contract

When deepwork is active, the orchestrator must manage the work as a scheduler,
not as the default implementation worker.

Required behavior:

- keep OpenCode todos aligned with the active deepwork phase;
- create and maintain a local markdown progress file under `.slim/deepwork/`;
- write valuable research findings into that file as confirmed research context
  when they are received and reconciled;
- draft a plan before implementation;
- ask `@oracle` to review the plan and revise it until acceptable;
- create a phased implementation/delegation plan;
- before oracle reviews, add relevant confirmed research findings and file
  references to the deepwork file so oracle can review the plan or phase from
  accepted context instead of redoing discovery;
- ask `@oracle` to review that implementation plan before execution;
- after oracle review and before each implementation phase, decide the execution
  path: what can run in parallel, what must be sequential, which specialists to
  delegate to, and whether to split the same agent into multiple bounded lanes;
- after each phase, validate, update the deepwork file, prepare the plan file
  for oracle review and ask `@oracle` to review the phase result, fix
  actionable issues, then continue;
- when a phase includes `@designer`, preserve designer intent across later
  phases. Use `@fixer` only for mechanical follow-up that does not alter the
  UI/UX;
- finish with final validation and a concise summary.

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

Keep `.slim/deepwork/` out of git, but make it readable to OpenCode. Ensure the
project ignore files include:

```gitignore
# .gitignore
.slim/deepwork/
```

```gitignore
# .ignore
!.slim/deepwork/
!.slim/deepwork/**
```

Do not follow a rigid template. Choose whatever markdown structure best fits the
work. The file only needs to remain useful as persistent session state and should
capture, as applicable:

- current goal and understanding;
- researched, factual context from `@librarian` to avoid oracle doing its own
  research;
- plan drafts and oracle review notes;
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
