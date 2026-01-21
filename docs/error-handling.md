# Error Handling Guidelines

To maintain consistency and reliability across the `oh-my-opencode-slim` codebase, follow these guidelines:

## Core Principles

- **Throw `Error`** for invariant violations, programmer errors, or when the caller cannot reasonably continue.
    - *Example*: Missing LSP server in `src/tools/lsp/utils.ts` or failed binary download in `src/tools/grep/downloader.ts`.
- **Return Structured Results** for tool/CLI boundaries and long-running workflows.
    - *Format*: `{ success: false, error: string }`.
    - *Example*: Configuration merging or model mapping results.
- **Prefix Tool Outputs** with `Error:` for LLM-facing results.
    - *Example*: `src/tools/background.ts` outputs. Keep formatting stable for automated consumers.
- **Include Context** in every message.
    - *Format*: `[component] operation: <message>`
    - *Example*: `[tmux] findTmuxPath: command not found`
- **Normalize Unknown Errors**. Use `err instanceof Error ? err.message : String(err)`. Avoid stringifying full error objects in user-facing messages.
- **Log and Continue** only for optional integrations.
    - *Example*: Tmux, auto-update, background init. Never swallow errors in required setup paths.
- **No Custom Error Classes** unless programmatic branching is strictly required across module boundaries.

## Compatibility Notes

- `src/tools/background.ts`: Tool outputs must stay string-based and prefixed with `Error:`.
- `src/tools/ast-grep/cli.ts` & `src/tools/grep/cli.ts`: Return `{ error }` fields in result objects instead of throwing.
- `src/cli/index.ts`: The top-level `main().catch` is the final safety net. Fatal errors should propagate here.
