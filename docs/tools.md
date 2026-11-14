# Tools & Capabilities

What Slim adds to OpenCode. Native tools are documented upstream; this page covers the tools Slim registers and the native calls it intercepts.

## apply_patch rescue

Slim intercepts the native patch tool — v1's `apply_patch` and v2's `patch` — before it runs. It rewrites recoverable stale patches, canonizes safe tolerant matches against the real file when unicode/trim drift is the only mismatch, keeps the authored `new_lines` bytes intact, preserves the existing file EOL/final-newline state for updates, validates malformed patches strictly before helper execution, uses a conservative bounded LCS fallback, accumulates helper state when the same path appears in multiple `Update File` hunks, blocks the call before native execution if any patch path falls outside the allowed root/worktree, and fails on ambiguity instead of guessing. It does not rewrite `edit` or `write` inputs. Disable with `disabled_hooks: ["apply-patch"]` (see [Hooks](configuration.md#hooks)).

---

## interview_submit_state

`interview_submit_state` stores the current interview state without printing the
specification or patch in assistant text. Use it once per interview turn: the
kickoff carries the full spec, and later turns carry a one-line status, an
optional unified diff against the current spec body, and questions.

## Web Fetch

Enhanced version of OpenCode's built-in `webfetch`. Overrides the default when
this plugin is active. Fetch remote pages with content extraction tuned for
docs/static sites.

| Tool | Description |
|------|-------------|
| `webfetch` | Fetch a URL with `llms.txt` probing, main-content extraction from HTML, binary save support, and a minimal conditional status header |

See the full [Webfetch documentation](webfetch.md) for parameters, output
format, caching, llms.txt probing, redirect policy, binary detection, and
implementation details.

`webfetch` blocks cross-origin redirects unless the requested URL or derived permission patterns explicitly allow them.

---

## Code Search Tools

Fast, structural code search and refactoring - more powerful than plain text grep.

| Tool | Description |
|------|-------------|
| `ast_grep_search` | AST-aware code pattern matching across 25 languages |
| `ast_grep_replace` | AST-aware code refactoring with dry-run support |

`ast_grep` understands code structure, so it can find patterns like "all arrow functions that return a JSX element" rather than relying on exact text matching.

If the ast-grep CLI is missing or cannot execute, the tools attempt automatic
recovery once, then return an error rather than retrying indefinitely.
Concurrent calls share recovery work. Missing paths are rediscovered locally
before downloading, so an installed CLI can be used offline. Only an unusable
plugin-cached binary is removed; package and system binaries are never deleted.
Downloaded Linux binaries require glibc.
On Alpine/musl, build a compatible binary locally
(`cargo install ast-grep --locked`), copy it to the plugin cache path shown in
the error, and restart OpenCode.

`ast_grep_replace` previews changes by default. Set `dryRun: false` to write
the replacements. Report-size limits do not limit which matching rewrites
are applied. Write failures and timeouts return errors instead of a successful
`[APPLIED]` report.
If the report is truncated, the output distinguishes successful writes from
dry-run previews and does not claim complete replacement or file totals.

Before the built-in `grep`/`glob` tools run, the plugin pre-checks that the
requested `path` is valid, using the same resolution rules as the host:
v1 `grep` joins relative paths, while v1 `glob` resolves them; v2 resolves
relative paths for both tools. Missing paths and paths with a non-directory
component fail fast with an actionable error instead of an opaque "ripgrep
execution failed" message or a silent search of the parent directory.
Resolution uses the host process's native path flavor, preserving Windows
drive-relative behavior; if no project directory is available, the guard
conservatively passes the path through. Disable with
`disabled_hooks: ["search-path-guard"]` (see [Hooks](configuration.md#hooks)).

---

## Background Task Control

| Tool | Description |
|------|-------------|
| `task_status` | Read a child's state and latest result by exact session ID |
| `task_report` | (V2 native) Send a bounded progress update or blocker from a running subagent to its owning parent; queue-only |
| `task_reply` | Answer a child's pending control request by exact session ID and request ID. On V2 it is a permission-only host bridge; answer questions in the host UI |
| `task_cancel` | Ask the host to interrupt the child's active execution while retaining its session |

`backgroundJobs.mode: "native"` is the V2 default. It leaves child execution,
continuation, completion delivery, and restart recovery to the host and
registers these controls:
`task_status`, `task_cancel`, and `task_reply` on the parent, plus the
child-only `task_report`. They take an exact child `sessionID` and verify `parentID` with a bounded host read. `mode: "off"` registers no OMOS task tool at all.

`task_status` reports what the host round and trailing transcript prove. On V2
that evidence is reconstructed from the child transcript, so an unfinished round
is `unconfirmed` rather than a live status claim. It also lists pending
permission requests for that exact child, bounded, when the host exposes
`permission.list`; a host without the capability reports `unavailable` instead
of inventing an empty list. This is an on-demand pull after a missing notice,
not a poll loop. `task_cancel` sends the host's own interrupt without a status
pre-check: it is a no-op for an idle session, reports whether the host reported
interruption, and leaves cleanup plus the terminal notification to the host. The
session is never deleted and stays continuable.

On V2 native, a child can use `task_report` for a material milestone,
consequential finding, blocker, or decision request. The recipient is always
read from the child session's host-owned `parentID`; callers cannot choose
another session. Reports enter the host's serialized inbox with
`delivery: "queue"` and `resume: false`: the tool confirms that the host queued
the report, not that the parent read it, started a turn, or woke. The parent can
reply by continuing the same child session with the native V2
`subagent(sessionID, prompt)` tool.

Continue a completed, errored, or interrupted child through
`subagent(sessionID, prompt)`. OpenCode resolves the exact session ID.
See [Background Orchestration](background-orchestration.md) for the lifecycle.

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

Exempt from the entire guard: `task`, `task_cancel`, `task_message`, and
`task_revive` — they legitimately re-issue identical calls while a background
task runs. `task_status` is warn-only (never hard-blocked), so a repeated
status read cannot deadlock result retrieval. The wait tools (`wait_for_user`,
`wait_for_background_tasks`) run a stricter per-turn counter of their own: the
second repeat warns, and the guard refuses further repeats in that turn.

Disable with `disabled_hooks: ["tool-loop-guard"]` (see
[Hooks](configuration.md#hooks)).

