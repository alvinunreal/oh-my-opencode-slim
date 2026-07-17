# Issue Draft — `omos-test` `--watch` flag enhancement

> **Note:** This is a draft for review. No `gh issue create` has been run.

---

## Issue Title

Add `--watch` flag to `omos-test` skill for automatic test reruns on file change

---

## Issue Body

### Description

The `omos-test` skill currently runs the test suite once and exits. Iterating on tests during development requires manually re-invoking the skill after each change, which breaks flow and slows down the red-green-refactor cycle.

**Proposed behavior:**

Add a `--watch` flag to `omos-test` that keeps the process running and re-executes the relevant tests whenever a file change is detected in the project. This would match the workflow provided by `bun test --watch` (or `jest --watch`, `vitest --watch`, etc.) but wrapped in the `omos-test` skill so it works naturally within OpenCode agent sessions.

**Suggested implementation sketch:**

```
omos-test --watch [<test-pattern>]
```

- The flag delegates to the underlying test runner's watch mode (e.g. `bun test --watch`).
- Output is streamed continuously within the skill's tmux pane or MCP session.
- On file save, tests rerun automatically for the affected files or the whole suite.
- The user can exit watch mode with Ctrl+C, returning to the agent prompt.

**Why this matters:**

- Faster iteration for test-driven development.
- No context-switching to manually re-run tests.
- Reduces friction in the @fixer and @explorer agent workflows where test verification is a frequent step.

### Skill / Command

`omos-test` (community skill for running tests in oh-my-opencode-slim)

### Environment

- OS: Linux mhenke-IdeaPad-Slim-3-15ARP10 7.0.14-2-liquorix-amd64 #1 ZEN SMP PREEMPT liquorix
- OpenCode: 1.18.3
- Plugin: oh-my-opencode-slim 2.2.3
- Node: v22.23.1
- Bun: 1.3.0
- Shell: /usr/bin/zsh

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

1. **Collect plugin log** — locate `~/.local/share/opencode/log/oh-my-opencode-slim.*.log` and tail last 500 lines.
2. **Scrub secrets** — run the one-liner scrubber (API keys, JWTs, tokens, emails, IPs) plus the PEM tripwire check.
3. **Show draft to user** for approval before submitting.
4. On approval: `gh issue create --repo alvinunreal/oh-my-opencode-slim --title "Add --watch flag to omos-test skill for automatic test reruns on file change" --label enhancement --body-file <tempfile>`
5. If `gh` unavailable: print full draft and link to https://github.com/alvinunreal/oh-my-opencode-slim/issues/new

---

## Analysis

This is a straightforward enhancement that would bring `omos-test` in line with standard test runner UX (`bun test --watch`, `jest --watch`, `vitest --watch`). The implementation likely involves:

- Parsing a `--watch` flag in the skill's argument handling.
- Mapping it to the underlying test runner's watch mode (e.g. `bun test --watch`).
- Ensuring the tmux/MCP session stays alive and streams output until the user stops it.
- Handling graceful shutdown (Ctrl+C → clean pane teardown).

The feature is opt-in (no breaking change), well-scoped, and directly improves developer experience for test-driven workflows in OpenCode.
