# OpenCode V2 native lifecycle upgrade

Slim requires **OpenCode 2.3.0 or newer**. Upgrade OpenCode before switching
to this Slim release. For npm installations, use
`npm install -g @opencode/cli@latest`. Then rerun the Slim installer to
register it under OpenCode's `plugins` configuration.
On OpenCode 1.x, pin `oh-my-opencode-slim@3.0.7` in the `plugin` list instead.

OpenCode runs subagents in the background and reports each settled child
period to its parent. [OpenCode 2.3 release notes](https://opencode.ai/changelog/v2.3.0)

On V2, the default changes from `managed` to `native`, even when no
`backgroundJobs` configuration is present. Slim's job board, short aliases,
reusable-session pool and managed limits stop applying; OpenCode owns child
execution, continuation, persistence, restart recovery and completion
notifications. The five-minute idle TODO reminder and the scheduler that sent
it were removed.

## Check configuration before upgrading

Review the user configuration and every inherited project configuration from
the directories where you run V2. This includes `OPENCODE_CONFIG_DIR` when set,
`.jsonc` files that take precedence over `.json`, and ancestor `.opencode`
directories, including `~/.opencode` for projects under your home directory.
The [configuration discovery rules](configuration.md#config-files) apply.

Each explicit configuration layer is validated before merging. Slim converts
`mode: "managed"` to `"native"` in its own layer and removes inert settings.
Warnings appear in the log and in `doctor`. Positive concurrency and wall-clock
limits are rejected because Slim no longer enforces them, even if a nearer layer
sets `mode: "off"`. The error names the source file, key and value:

```text
<config path>: Unsupported backgroundJobs.concurrency.providerConcurrency.openai = 2 on OpenCode v2: Slim no longer enforces this limit. Remove the key or set it to 0, then run /reload.
```

From each project, run `oh-my-opencode-slim doctor` using the new plugin
version. It reports incompatible settings in
each configuration file before you start OpenCode.
When startup is refused, OpenCode shows "Plugin failed: oh-my-opencode-slim".
Open `/plugins` and select "view error" for the file and setting, or run
`oh-my-opencode-slim doctor`. After correcting the file, run `/reload`.

| Existing setting | V2 behavior |
|---|---|
| `backgroundJobs.mode: "managed"` | Applied as `"native"` with a warning. Set `"off"` to disable Slim task tools and session bindings. |
| `backgroundJobs.concurrency` | Positive default, provider or model limits are rejected; empty, zero or malformed values are removed with a warning. |
| `backgroundJobs.wallClockTimeoutMs` | A positive deadline is rejected; zero, negative or malformed values are removed with a warning. |
| `backgroundJobs.maxSessionsPerAgent`, `backgroundJobs.stopConfirmationMs` | Removed with a warning. |
| `backgroundJobs.sameProviderPolicy`, `waitForUserGuard`, `childInputWake`, `childInputWakeKinds`, `pruneEvictedSessions` | Removed with a warning. |

An example V2 configuration after review is:

```jsonc
{
  "backgroundJobs": { "mode": "native" }
}
```

These removals do not provide equivalent host limits. Review any requirement
for concurrency, deadlines or session retention against your OpenCode host
before upgrading.

Remove `orchestratorWake` from `backgroundJobs` after review. Slim warns for
each configuration file that declares this retired setting.

## Existing sessions and automation

Finish managed V2 work before switching releases. Old Slim board and delivery
records remain in plugin storage, unread and unchanged; this release neither
imports them into native Jobs nor deletes them. Their aliases and retention
state are no longer used. Existing host sessions remain stored in OpenCode;
continue them by exact
`sessionID` through native `subagent(sessionID, prompt)`.

Automation must use exact session IDs. In V2 native mode, `task_status` reads a
child's trailing result and pending permissions, `task_cancel` asks the host to
interrupt it, and `task_reply` answers permissions only. Answer questions in the
host UI. The pre-existing child `task_report` admits an update with
`delivery: "steer"` and requests a wake unless the parent's outcome is
`interrupted`. Acceptance does not confirm processing.

Native restart recovery is owned by OpenCode and can repeat external effects.
It does not provide exactly-once execution. See
[Background Orchestration](background-orchestration.md) for the lifecycle and
[Tools](tools.md#background-task-control) for the control surface.
