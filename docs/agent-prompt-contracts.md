# Agent Prompt Contracts

OMO Slim keeps the [background orchestration](background-orchestration.md)
model: the orchestrator schedules and reconciles specialist work rather than
becoming the default implementation worker. Roles describe specializations,
not fixed quality, latency, or cost ratios between user-selected models.

## Compact handoffs

A delegation supplies the objective, allowed scope and exclusions, acceptance
criteria, and a validation owner with assigned checks (or explicitly none).
Reference relevant files instead of pasting whole files. Include decisions
that are not in those files; a new specialist must not have to guess what was
agreed in the parent conversation. Continuing a matching session can use a
short delta with any changed constraints.

Results distinguish completed work from partial changes and blockers. Writer
agents run only their assigned validation and report results and skips
accurately. The orchestrator reconciles writer lanes before final validation
and reuses evidence only while it remains valid for the final state.

For example, a bounded handoff can say:

> Implement the agreed empty-state behavior in `src/widget.ts`. Preserve its
> public API and do not modify styling. Acceptance: an empty response renders
> the existing empty state without throwing. The existing product wording was
> approved in the parent discussion; do not replace it. Fixer owns the focused
> widget test; orchestrator owns final integration validation. Return changed
> paths, the test result, and any unmet acceptance criteria.

This is a content contract, not a mandatory new template or workflow engine.
The existing narrow direct-work exception, task recovery, cancellation,
parallel write ownership, and host-specific delegation tools are unchanged.

## Specialist boundaries

Designer owns visual and interaction decisions, including implementation.
Its distinctive aesthetic guidance applies where the user brief and existing
design system leave room; it does not authorize unrelated restyling or trading
away correctness and accessibility. Copy follows the requested product
language and existing localization conventions.

Fixer can perform explicitly specified mechanical follow-up that preserves an
approved design exactly. New visual judgment or changed interaction intent
belongs to Designer. Frontend file ownership alone is not the distinction.

Explorer searches the requested scope and reports search gaps without
presenting a limited search as proof of absence. Librarian grounds advice in
the project's dependency version and distinguishes official documentation
from community examples. Oracle separates evidenced findings, hypotheses,
and optional improvements; it remains an escalation, not an automatic review
step. Observer transcribes visible text with native reading and marks
unreadable portions rather than implying an unavailable OCR pipeline.
Council synthesizes supplied councillor results without tools.

## Customization and cache safety

These are built-in defaults. Existing full prompt overrides remain
unchanged; they do not automatically acquire changes to the replaced prompt.
See [configuration](configuration.md) for prompt override precedence.

Prompt construction stays deterministic and session-frozen. Deliberate text
changes require updating the existing golden snapshots and can require cache
re-warming when the new defaults are loaded. This does not add per-turn prompt
rewrites or change message injection, tool sets, permissions, or config schema.

## Verification and behavioral evaluation

`src/agents/prompt-contracts.test.ts` checks rendered instruction contracts.
The existing factory-prompt and cache-payload snapshots pin the full text.
Run the normal `bun run check:ci`, `bun run typecheck`, `bun test`, and
`bun run build` checks when editing these defaults.

String assertions and code-review scores are not evidence of better model
behavior. Compare old and new prompts on repeated, identical tasks with
both shared-model and mixed-model presets. Useful scenarios include bounded
implementation, parallel non-overlapping writers, context absent from files,
approved-design mechanical follow-up versus redesign, version-specific APIs,
a review with no actionable findings, and partly unreadable visual input.

Record correctness and safety first, then unnecessary delegations, repeated
reads, repair rounds, actual token usage, latency, and cache reuse. Do not
claim a speed or cost improvement from shorter text or a reviewer score alone.
