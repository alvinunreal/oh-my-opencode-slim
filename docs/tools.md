# Tools & Capabilities

Built-in tools available to agents beyond the standard file and shell operations.

## apply_patch rescue

Slim only intercepts `apply_patch` before the native tool runs. It rewrites recoverable stale patches, canonizes safe tolerant matches against the real file when unicode/trim drift is the only mismatch, keeps the authored `new_lines` bytes intact, preserves the existing file EOL/final-newline state for updates, validates malformed patches strictly before helper execution, uses a conservative bounded LCS fallback, accumulates helper state when the same path appears in multiple `Update File` hunks, blocks `apply_patch` before native execution if any patch path falls outside the allowed root/worktree, and fails on ambiguity instead of guessing. It does not rewrite `edit` or `write` inputs.

---

## Web Fetch

Enhanced version of OpenCode's built-in `webfetch`. Overrides the default when
this plugin is active. Fetch remote pages with content extraction tuned for
docs/static sites.

| Tool | Description |
|------|-------------|
| `webfetch` | Fetch a URL, optionally prefer `llms.txt`, extract main content from HTML, include metadata, optionally save binary responses, and optionally run secondary-model extraction |

See the full [Webfetch documentation](webfetch.md) for parameters, output
format, caching, llms.txt probing, redirect policy, secondary-model
summarization, binary detection, and implementation details.

`webfetch` blocks cross-origin redirects unless the requested URL or derived permission patterns explicitly allow them, and it can fall back to the raw fetched content when secondary-model summarization is unavailable.

---

## Code Search Tools

Fast, structural code search and refactoring - more powerful than plain text grep.

| Tool | Description |
|------|-------------|
| `grep` | Fast content search using ripgrep |
| `ast_grep_search` | AST-aware code pattern matching across 25 languages |
| `ast_grep_replace` | AST-aware code refactoring with dry-run support |

`ast_grep` understands code structure, so it can find patterns like "all arrow functions that return a JSX element" rather than relying on exact text matching.

---

## Background Task Control

| Tool | Description |
|------|-------------|
| `task` | Start a specialist task and return its task ID |
| `task_status` | Check the status of a task |
| `task_result` | Retrieve a task's result |
| `task_message` | Queue a non-interrupting message and return `queued` |
| `task_cancel` | Stop a generation while retaining its session |
| `task_revive` | Resume a retained session with a new instruction |
| `wait_for_user` | Pause automatic orchestrator wake prompts until the next distinct external user message |

The task controls use the task ID or Background Job Board alias for the task being
managed. `task_message` does not interrupt the current generation. `task_cancel`
stops the generation but retains its session; it does not roll back partial edits.
After cancelling a write-capable task, inspect and reconcile file changes before
launching replacement work.

`task_revive` resumes a retained session with a new instruction. A cancelled or
errored retained session may be revived immediately once its retained state has
been verified safe. Acknowledgement controls parent and job-board consumption and
reusable-pool display, not same-session revival.

`wait_for_user` is also orchestrator-only. The orchestrator uses it as the final
tool action after providing concrete instructions for external manual work. Its
`reason` is diagnostic text only; the plugin does not parse assistant prose to
decide whether a turn is HITL. A new real user text/file/image message clears the
wait. Synthetic/internal messages and duplicate delivery of the user message
that preceded the wait do not.

See the background orchestration concepts in
[Background Orchestration](background-orchestration.md) for the session
lifecycle, cancellation, and explicit-wait edge cases behind these tools.

---

## Repeated Tool-Call Loop Guard

A safety net for model-side infinite loops where a sub-agent (e.g. a model
that can degenerate, such as DeepSeek V4 Flash in Explorer) re-issues the
exact same tool call with identical arguments and gets identical results,
making no progress. The plugin watches each session's consecutive identical
tool calls — counting only calls that return results identical to the
previous call, so a call returning new information (e.g. a file that was
modified) never counts toward a block — and responds:

- After the 3rd confirmed-identical result: appends a corrective notice to
  the tool output telling the model to stop repeating and change approach.
  Applies to all tools.
- After the 5th confirmed-identical result: refuses the next identical call
  for the read-only file tools `read`, `grep`, and `glob`, terminating the
  loop. Other tools stay warn-only.

The count is confirmed in `tool.execute.after`, so overlapping parallel
calls cannot inflate it before their results are known.

Exempt from the entire guard: the task-control and wait tools (`task`,
`task_status`, `task_result`, `task_cancel`, `task_message`, `task_revive`,
`wait_for_user`, `wait_for_background_tasks`) — those legitimately re-issue
identical calls while polling a long-running background task.

---

## Formatters

OpenCode automatically formats files after they are written or edited, using language-specific formatters. No manual step needed.

Includes Prettier, Biome, `gofmt`, `rustfmt`, `ruff`, and 20+ others.

> See the [official OpenCode docs](https://opencode.ai/docs/formatters/#built-in) for the complete list.

---
