# Tools & Capabilities

Built-in tools available to agents beyond the standard file and shell operations.

## apply_patch rescue

Slim only intercepts `apply_patch` before the native tool runs. It rewrites recoverable stale patches, canonizes safe tolerant matches against the real file when unicode/trim drift is the only mismatch, keeps the authored `new_lines` bytes intact, preserves the existing file EOL/final-newline state for updates, validates malformed patches strictly before helper execution, uses a conservative bounded LCS fallback, accumulates helper state when the same path appears in multiple `Update File` hunks, blocks `apply_patch` before native execution if any patch path falls outside the allowed root/worktree, and fails on ambiguity instead of guessing. It does not rewrite `edit` or `write` inputs.

---

## Background Tasks

Launch agents asynchronously and collect results later. This is how the Orchestrator runs Explorer, Librarian, and other sub-agents in parallel without blocking.

| Tool | Description |
|------|-------------|
| `background_task` | Launch an agent in a new session. `sync=true` blocks until complete; `sync=false` returns a task ID immediately |
| `background_output` | Fetch the result of a background task by ID |
| `background_cancel` | Abort a running background task |

Background tasks integrate with [Multiplexer Integration](multiplexer-integration.md) — when multiplexer support is enabled, each background task spawns a pane so you can watch it live.

---

## Web Fetch

Fetch remote pages with content extraction tuned for docs/static sites.

| Tool | Description |
|------|-------------|
| `webfetch` | Fetch a URL, optionally prefer `llms.txt`, extract main content from HTML, include metadata, and optionally save binary responses |

`webfetch` blocks cross-origin redirects unless the requested URL or derived permission patterns explicitly allow them, and it can fall back to the raw fetched content when secondary-model summarization is unavailable.

---

## LSP Tools

Language Server Protocol integration for code intelligence across 30+ languages. OpenCode ships pre-configured LSP servers for TypeScript, Python, Rust, Go, and more.

| Tool | Description |
|------|-------------|
| `lsp_goto_definition` | Jump to a symbol's definition |
| `lsp_find_references` | Find all usages of a symbol across the workspace |
| `lsp_diagnostics` | Get errors and warnings from the language server |
| `lsp_rename` | Rename a symbol across all files atomically |

> See the [official OpenCode docs](https://opencode.ai/docs/lsp/#built-in) for the full list of built-in LSP servers and their requirements.

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

## Formatters

OpenCode automatically formats files after they are written or edited, using language-specific formatters. No manual step needed.

Includes Prettier, Biome, `gofmt`, `rustfmt`, `ruff`, and 20+ others.

> See the [official OpenCode docs](https://opencode.ai/docs/formatters/#built-in) for the complete list.

---

## Todo Continuation

Auto-continue the orchestrator when it stops with incomplete todos. Opt-in — no automatic behavior unless enabled.

| Tool / Command | Description |
|----------------|-------------|
| `auto_continue` | Toggle auto-continuation. Call with `{ enabled: true }` to activate, `{ enabled: false }` to disable |
| `/auto-continue` | Slash command shortcut. Accepts `on`, `off`, or toggles with no argument |

**How it works:**

1. When the orchestrator goes idle with incomplete todos, a countdown notification appears
2. After the cooldown (default 3s), a continuation prompt is injected — the orchestrator resumes work
3. Press Esc×2 during cooldown or after injection to stop

**Safety gates** (all must pass before continuation):

- Auto-continue is enabled
- Session is the orchestrator
- Incomplete todos exist
- Last assistant message is not a question
- Consecutive continuation count is under the limit
- Not in post-abort suppress window (5s)
- No pending injection already in flight

**Configuration** in `oh-my-opencode-slim.json`:

```jsonc
{
  "todoContinuation": {
    "maxContinuations": 5,      // Max consecutive auto-continuations (1–50)
    "cooldownMs": 3000,         // Delay before each continuation (0–30000)
    "autoEnable": false,        // Auto-enable when session has enough todos
    "autoEnableThreshold": 4    // Number of todos to trigger auto-enable
  }
}
```

> See [Configuration](configuration.md) for the full option reference.
