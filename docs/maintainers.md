# Maintainer Guide

This document is the source of truth for issue triage and lightweight repo maintenance in `oh-my-opencode-slim`.

## Goals

- Bug reports stay actionable; filing stays lightweight.
- Support questions go to Telegram, not the issue tracker.
- Maintainers decide quickly and apply the same standard each time.

## Where Different Things Go

### GitHub Issues

Use issues for:

- bug reports
- feature requests

### Telegram

Use the Telegram channel for:

- setup questions
- troubleshooting help
- general support
- open-ended usage questions

If an issue is really a support request, reply briefly and redirect the user to [Telegram](https://t.me/boringdystopiadevelopment).

## Issue Forms

### Bug report

Bug reports should include:

- what happened
- what was expected
- steps to reproduce
- relevant config
- OpenCode version
- `oh-my-opencode-slim` version
- operating system
- logs, screenshots, or extra context if relevant

The goal is enough information to reproduce the issue without turning the form into paperwork.

### Feature request

Feature requests should stay lightweight and focus on:

- the problem
- the requested change
- optional extra context

### Community preset submission

Community preset submissions use a separate form (`preset_submission.yml`).
These require preset name, GitHub handle, config block, supported providers, and
intended use case. Label with `community-preset` and review for clarity and
validity before merging.

## Labels

The canonical label taxonomy is defined in
[`docs/agents/triage-labels.md`](agents/triage-labels.md). This section covers
triage procedure only.

## Triage Flow

Requires the `triage` skill from `mattpocock/skills`.

**Install the skill:** `npx skills add https://github.com/mattpocock/skills --skill triage`

The label mapping the skill expects is already provided in
[`docs/agents/triage-labels.md`](agents/triage-labels.md). You do **not** need to
run `/setup-matt-pocock-skills` for this repo.

Route each new issue:

1. **Bug report or feature request?** → run `/triage`. Canonical roles and their
   GitHub label mappings live in
   [`docs/agents/triage-labels.md`](agents/triage-labels.md); the skill owns the
   role model and state transitions.
2. **Support request?** → reply briefly, redirect to [Telegram](https://t.me/boringdystopiadevelopment), close if needed.

**PRs are a separate surface.** External PRs get category labels only
(`bug`/`enhancement`) and do not enter the triage state machine. See
[`docs/agents/issue-tracker.md`](agents/issue-tracker.md) for the full PR
triage policy.

This guide covers only repo-specific routing. The `triage` skill and
`triage-labels.md` handle label application and state transitions.

## Closing Policy

- Close issues manually for now.
- Do not use stale-bot automation.
- If an issue lacks the details needed to proceed, ask for the missing information clearly and keep the ask short.

## Pull Requests

PRs use a minimal prompt:

> What changed, and why was it needed?

The goal is clarity without process overhead.

## Coverage in the CI audit

The test job converts Bun's LCOV report into
`coverage/coverage-final.json` with `bun run coverage:istanbul`. The
report-only Fallow job waits for the test job, downloads
`test-results-bun-pinned` into the checkout, and auto-detects that file for
CRAP scoring. The audit remains non-blocking and skips when the test job
fails. The Fallow job installs dependencies with `bun ci` before analysis
so dependency resolution does not run with missing `node_modules`.

To reproduce from the repository root:

```bash
bun ci
bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage
bun run coverage:istanbul
npx fallow@3.43.0 audit --base origin/master --no-css
```

Function coverage is a line-derived approximation. The converter uses
ast-grep function ranges and marks a function covered when any LCOV line
inside its range has a hit. Shared lines or nested functions can therefore
mark an uncalled function covered. The output has binary function hits,
one synthetic statement per LCOV line, and no branch coverage or invocation
counts. Functions not reconstructed by ast-grep have no measured function
coverage; Fallow can fall back to estimates for unmatched functions.

Keep the artifact at `coverage/coverage-final.json`. Both CI jobs use the
same checkout path; no `--coverage-root` override is needed. In the audit
JSON, check `complexity.summary.istanbul_matched` is greater than zero to
confirm measured coverage was matched rather than silently using estimates.

## Future Changes

If issue volume or maintainer load changes, this document can grow to include:

- more labels
- stronger prioritization rules
- stale policies
- contributor workflow guidance

Until then, keep the system slim.
