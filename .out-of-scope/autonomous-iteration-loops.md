# Autonomous Iteration Loops (ralph-loop)

This project does not bundle autonomous iteration-loop harnesses (e.g. a
ralph-loop feature driving repeated autonomous turns until a goal is met).

## Why this is out of scope

On PR #44 ("feat: Add ralph-loop autonomous iteration feature"),
alvinunreal declined bundling it:

> Thanks @fparrav - this is something I would say better as a standalone
> plugin; installed by users;
> Not sure if we need to bundle inside slim fork

An iteration-loop harness is a substantial behavior layer on top of the agent
runtime — its stop conditions, budgets, and recovery semantics are product
decisions of their own, and bundling one makes every slim user pay the prompt
and maintenance cost of a feature most don't use. The plugin intentionally
stays an orchestration layer; loop harnesses fit the ecosystem as standalone
plugins users opt into.

Note the host now owns this surface: OpenCode v2.2.1+ ships a built-in
`/goal` command (an objective plus reviewer-driven continuation), so this
plugin bundles no loop command of its own. A general autonomous-iteration
harness remains the standalone-plugin candidate.

## Prior requests

- PR #44 — "feat: Add ralph-loop autonomous iteration feature" (closed)