# Response: report-issue skill evaluation (eval-2)

## Summary

Used the `/report-issue` skill to draft a GitHub issue for adding a `--watch` flag to the `omos-test` skill.

## Workflow Steps Completed

### Step 1 — Gather user input
User provided all required info in a single message:
- **Title:** Add `--watch` flag to `omos-test` skill for test rerun on file change
- **Type:** enhancement
- **Description:** Add a `--watch` flag to `omos-test` so it reruns tests on file change using the test framework's built-in watch capability
- **Skill/command:** `omos-test`

### Step 2 — Collect environment
Ran environment info collection. Result:
- OS: Linux mhenke-IdeaPad-Slim-3-15ARP10 7.0.14-2-liquorix-amd64...
- OpenCode: 1.18.3
- Plugin: 2.2.3
- Node: v22.23.1
- Bun: 1.3.0
- Shell: /usr/bin/zsh

### Step 3 — Collect plugin logs
Found log: `/home/mhenke/.local/share/opencode/log/oh-my-opencode-slim.20260717T020931.log`

### Step 4 — Scrub the log
- PEM tripwire check: CLEAR (no private key detected)
- Scrubbed 500 lines via the skill's bun-based scrubber (API keys, tokens, JWTs, URLs, emails, IPs, home paths all redacted)
- Scrubbed log size: 104,927 chars → truncated to ~6,000 chars at line boundaries per skill rules

### Step 5 — Draft the issue body
Saved to `/tmp/omos-issue.md` using the template from the skill.

### Step 6 — Confirm (STOP here — test)
Showed the raw draft to the user. Did NOT run `gh issue create`. Asked for approval.

---

## Draft Issue

**Title:** Add `--watch` flag to `omos-test` skill for test rerun on file change

**Label:** `enhancement`

**Body (truncated view — full draft at `/tmp/omos-issue.md`):**

\`\`\`markdown
## Description

Add a \`--watch\` flag to the \`omos-test\` skill so it reruns tests automatically when
source files change. Currently, \`omos-test\` runs the configured test suite once and
exits. A watch mode would (a) re-run tests on file changes using the underlying test
framework's built-in watch capability (e.g., \`bun test --watch\`), and (b) improve the
developer iteration loop inside omos sessions.

**Desired behavior:**

- \`omos-test --watch\` starts a persistent test watcher
- Tests rerun automatically on changes to source/test files
- Ctrl+C or session teardown cleanly stops the watcher
- Works with \`bun test --watch\` under the hood as the default, with a fallback to
  other watchers if needed

**Implementation sketch:**

1. Add \`--watch\` as a boolean flag in the skill's CLI args
2. When \`--watch\` is set, pass \`--watch\` (or equivalent) to the underlying test command
3. Handle graceful shutdown of the watch process on session teardown / cancellation
4. Update the skill's docs to document the new flag

## Skill / Command

\`omos-test\` skill — the omos skill that runs project tests.

## Environment

- OS: Linux mhenke-IdeaPad-Slim-3-15ARP10 ...
- OpenCode: 1.18.3
- Plugin: 2.2.3
- Node: v22.23.1
- Bun: 1.3.0
- Shell: /usr/bin/zsh

## Plugin Logs (last 500 lines, scrubbed)

<details>
<summary>Click to expand — scrubbed plugin log</summary>

\`\`\`log
[2026-07-17T02:09:31.717Z] [multiplexer] Created tmux instance 
[2026-07-17T02:09:31.717Z] [plugin] initialized with multiplexer config ...
... [truncated — review may be incomplete; attach raw log manually]
\`\`\`

</details>

---
🤖 This issue was created using the /report-issue skill.
\`\`\`

---

**Status:** Stopped at confirmation step (step 6). `gh issue create` was NOT run as this is a test. Awaiting user approval to proceed.
