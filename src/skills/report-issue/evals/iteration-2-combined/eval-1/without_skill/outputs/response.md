# Issue Draft — @explorer tmux hang bug

> **Note:** This is a draft for review. No `gh issue create` has been run.

---

## Issue Title

@explorer throws error and tmux pane hangs when searching codebase

---

## Issue Body

### Description

Running `@explorer` to search the codebase causes the agent to throw an error, after which the tmux pane hangs indefinitely. The pane does not close or return to a prompt — it becomes unresponsive and must be killed manually.

**Steps to reproduce:**
1. Open OpenCode on macOS (latest version).
2. Invoke `@explorer` with any search query (e.g., "find files related to MCP").
3. Observe: the @explorer agent reports or logs an error.
4. After the error, the tmux pane stops responding — no further input is accepted, and the pane must be force-closed via tmux kill-pane or terminal close.

**Expected behavior:**
- On error, @explorer should report the error gracefully and the tmux session should either return to a usable state or close cleanly.

**Actual behavior:**
- The tmux pane hangs after the error, requiring manual cleanup.

### Skill / Command

@explorer agent

### Environment

- OS: macOS (version TBD — would collect via `uname -a`)
- OpenCode: latest (version TBD — would collect via `opencode --version`)
- Plugin: oh-my-opencode-slim (version TBD — would collect from `package.json`)
- Node: (version TBD — would collect via `node --version`)
- Bun: (version TBD — would collect via `bun --version`)
- Shell: (would collect via `$SHELL`)

### Plugin Logs (last 500 lines, scrubbed)

<details>
<summary>Click to expand — scrubbed plugin log</summary>

```log
[no plugin log available in this eval environment — would be collected and scrubbed in production]
```

</details>

---

🤖 This issue was drafted using the report-issue workflow.

## Next Steps (if this were real)

1. **Collect environment** — run `uname -a`, `opencode --version`, `bun --version`, etc.
2. **Collect plugin log** — locate `~/.local/share/opencode/log/oh-my-opencode-slim.*.log` and tail last 500 lines.
3. **Scrub secrets** — run the one-liner scrubber (API keys, JWTs, tokens, emails, IPs) plus the PEM tripwire check.
4. **Show draft to user** for approval before submitting.
5. On approval: `gh issue create --repo alvinunreal/oh-my-opencode-slim --title "..." --label bug --body-file <tempfile>`
6. If `gh` unavailable: print full draft and link to https://github.com/alvinunreal/oh-my-opencode-slim/issues/new

---

## Analysis

The most likely root cause is a missing or broken `session.deleted` event handler in the tmux multiplexer — if @explorer errors out without cleanly aborting its session, the tmux pane orphan persists. The fix would likely be in `src/multiplexer/tmux/index.ts` (graceful shutdown path) or `src/index.ts` (event handler wiring). Relevant docs: `AGENTS.md` Tmux Session Lifecycle Management section.
