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
- draft a plan before implementation;
- ask `@oracle` to review the plan and revise it until acceptable;
- create a phased implementation/delegation plan;
- ask `@oracle` to review that implementation plan before execution;
- execute phase by phase with specialist delegation where useful;
- after each phase, validate, update the deepwork file, ask `@oracle` to review
  the phase result, fix actionable issues, then continue;
- finish with final validation and a concise summary.

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
- assumptions, constraints, and decisions;
- plan drafts and oracle review notes;
- implementation phases and status;
- validation results;
- unresolved questions, blockers, and follow-ups.

Update this file after major decisions, reviews, phase completions, validation
results, and scope changes.

## Scheduler Discipline

Use the V2 scheduler model throughout:

- dispatch `@explorer`, `@librarian`, `@fixer`, `@designer`, `@oracle`, or
  `@council` lanes as background tasks when useful;
- record task/session IDs and ownership boundaries;
- poll `task_status` before consuming background results;
- reconcile terminal results before dependent work;
- keep write scopes separate when parallelizing;
- do not advance to the next phase while relevant jobs are running or terminal
  results are unreconciled.

`@oracle` owns review and risk assessment. It should review plans and completed
phase outputs, not become the default implementer.

## Lightweight Judgment

Deepwork is meant to prevent chaotic long sessions, not create paperwork. Keep
the markdown concise, batch small related checks when reasonable, and scale the
number of review gates to the risk of the work. If the task becomes small and
obvious, finish simply while preserving validation and the final summary.
