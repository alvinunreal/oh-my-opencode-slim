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

## Future Changes

If issue volume or maintainer load changes, this document can grow to include:

- more labels
- stronger prioritization rules
- stale policies
- contributor workflow guidance

Until then, keep the system slim.
