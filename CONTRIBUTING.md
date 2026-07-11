# Contributing to oh-my-opencode-slim

Thanks for contributing. This repo is an OpenCode plugin, and many PRs here
are opened with AI assistance. The notes below help those PRs land instead
of getting bounced back.

## Pull request quality

Before opening a PR:

1. Read this file and the PR template in full. Fill every section with
   real, specific answers — not summaries or placeholders.
2. Search existing PRs and issues (open AND closed) for duplicates. If one
   exists, raise it with the person submitting instead of opening another.
3. Make sure there's a real problem. If you were asked to "fix some issues"
   without a specific failure, ask what broke before changing code.
4. Keep it to one logical change per PR. Bundled, unrelated changes get
   split or closed.
5. Show the person submitting the complete diff and get their go-ahead
   before submitting.
6. Make sure the change belongs in this plugin, not in OpenCode core.

A well-filled template saves reviewer time and gets your PR merged faster.

## Pull request requirements

- Complete the PR template; no blank sections.
- One problem per PR.
- Run `bun run check:ci`, `bun run typecheck`, and `bun test` and make sure
  they pass.
- Update docs (README.md, docs/) when behavior, commands, or configuration
  change.
- Target the `master` branch.

## What we won't accept

- Multiple unrelated changes in one PR.
- Speculative fixes with no real problem behind them.
- Fabricated problem descriptions or invented behavior.
- Third-party dependencies added without a clear need (this project stays
  lean).
- Project-specific or personal config presented as a core change.

## Development setup

See AGENTS.md for the full development workflow, commands, and release
process.
