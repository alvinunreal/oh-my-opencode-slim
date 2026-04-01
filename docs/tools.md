# Tools & Capabilities

Built-in tools available to agents beyond the standard file and shell operations.

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
