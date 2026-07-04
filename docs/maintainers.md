# Maintainer Guide

This document is the source of truth for issue triage and lightweight repo maintenance in `oh-my-opencode-slim`.

## Goals

- Keep bug reports actionable.
- Keep issue filing lightweight.
- Keep support out of the issue tracker.
- Keep maintainer decisions fast and consistent.

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

If an issue is really a support request, reply briefly and redirect the user to Telegram.

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

## Labels

Only use these labels:

- `bug` - bug report
- `enhancement` - feature request or improvement
- `needs-info` - cannot act yet because key details are missing
- `confirmed` - a maintainer confirmed the issue or agrees the request is valid
- `P0` - highest priority
- `Share Your Thoughts` - open-ended feedback from the community

If a label does not help triage or prioritization, do not add it.

## Triage Flow

For each new issue, make a quick first decision:

1. Is it a bug report, a feature request, or support?
2. Is there enough information to act on it?
3. Is it confirmed?

### Bug reports

- Add `bug` if needed.
- Add `needs-info` if required details are missing.
- Add `confirmed` once a maintainer reproduces it or agrees it is valid and actionable.
- Add `P0` only for the highest-priority problems.

### Feature requests

- Add `enhancement` if needed.
- Add `confirmed` when maintainers agree it is a valid direction worth tracking.
- Add `P0` only if it is truly urgent.

### Support issues

- Reply briefly.
- Redirect the user to Telegram.
- Close if needed.

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
