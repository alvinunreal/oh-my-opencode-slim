# Tools & Capabilities

Built-in tools available to agents beyond the standard file and shell operations.

## apply_patch rescue

Slim only intercepts `apply_patch` before the native tool runs. It rewrites recoverable stale patches, canonizes safe tolerant matches against the real file when unicode/trim drift is the only mismatch, keeps the authored `new_lines` bytes intact, preserves the existing file EOL/final-newline state for updates, validates malformed patches strictly before helper execution, uses a conservative bounded LCS fallback, accumulates helper state when the same path appears in multiple `Update File` hunks, blocks `apply_patch` before native execution if any patch path falls outside the allowed root/worktree, and fails on ambiguity instead of guessing. It does not rewrite `edit` or `write` inputs.

---

## Web Fetch

Fetch remote pages with content extraction tuned for docs/static sites.

| Tool | Description |
|------|-------------|
| `webfetch` | Fetch a URL, optionally prefer `llms.txt`, extract main content from HTML, include metadata, and optionally save binary responses |

`webfetch` blocks cross-origin redirects unless the requested URL or derived permission patterns explicitly allow them, and it can fall back to the raw fetched content when secondary-model summarization is unavailable.

---

## Code Search Tools

Fast, structural code search and refactoring — more powerful than plain text grep.

| Tool | Description |
|------|-------------|
| `grep` | Fast content search using ripgrep |
| `ast_grep_search` | AST-aware code pattern matching across 25 languages |
| `ast_grep_replace` | AST-aware code refactoring with dry-run support |

`ast_grep` understands code structure, so it can find patterns like "all arrow functions that return a JSX element" rather than relying on exact text matching.

---

## Session Subtask

Run a focused child worker session for a bounded task and return its summary to
the caller.

| Command / Tool | Description |
|----------------|-------------|
| `/subtask <goal>` | Ask the current agent to prepare and start a bounded worker for the requested task |
| `subtask` | Creates a child orchestrator session and returns its structured summary |
| `read_session` | Lets a subtask worker inspect the source session when needed context is missing |

Slim creates a real child session with the current session as `parentID`, injects
relevant file context, and asks the worker to complete only the requested task.
The worker returns a `<subtask_summary>` with status, changes, files touched,
validation, and follow-up notes. In tmux/zellij this appears like other child
agent work: a pane can open for the worker and close after cleanup.

See [Subtask](subtask.md) for the full workflow.

---

## Formatters

OpenCode automatically formats files after they are written or edited, using language-specific formatters. No manual step needed.

Includes Prettier, Biome, `gofmt`, `rustfmt`, `ruff`, and 20+ others.

> See the [official OpenCode docs](https://opencode.ai/docs/formatters/#built-in) for the complete list.

---

## Todo Continuation

Auto-continue has its own guide now:

- [Todo Continuation](todo-continuation.md) — controls, safety gates, behavior, and config

---

## Session Goal

Pin a session-scoped objective that keeps planning, todos, delegation, and
verification aligned.

| Command | Description |
|---------|-------------|
| `/goal <objective>` | Set the current session goal |
| `/goal` | Show the active goal |
| `/goal clear` | Clear the active goal |
| `/goal from <interview>` | Promote an interview markdown spec into the active goal |

See [Session Goal](session-goal.md) for the full workflow.
