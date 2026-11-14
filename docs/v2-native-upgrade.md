# OpenCode V2 native lifecycle upgrade

Slim requires **OpenCode 2.3.0 or newer**. Upgrade OpenCode before switching
to this Slim release. For npm installations, use
`npm install -g @opencode/cli@latest`. Then rerun the Slim installer to
register it under OpenCode's `plugins` configuration.

OpenCode runs subagents in the background and reports each settled child
period to its parent. [OpenCode 2.3 release notes](https://opencode.ai/changelog/v2.3.0)

On V2, the default changes from `managed` to `native`, even when no
`backgroundJobs` configuration is present. Slim's job board, short aliases,
reusable-session pool and managed limits stop applying; OpenCode owns child
execution, continuation, persistence, restart recovery and completion
notifications.

## Check configuration before upgrading

Review the user configuration and every inherited project configuration from
the directories where you run V2. This includes `OPENCODE_CONFIG_DIR` when set,
`.jsonc` files that take precedence over `.json`, and ancestor `.opencode`
directories, including `~/.opencode` for projects under your home directory.
The [configuration discovery rules](configuration.md#config-files) apply.

Each explicit configuration layer is validated before merging. A nearer
`mode: "native"` does not hide `mode: "managed"` or a retired limit in an older
user or ancestor layer. The startup error names the source file and key; the
plugin refuses initialization rather than silently dropping the setting:

```text
<config path>: Unsupported backgroundJobs.mode "managed" on OpenCode v2; use "native" or "off".
```

From each project, run `oh-my-opencode-slim doctor` using the new plugin
version. It reports incompatible settings in
each configuration file before you start OpenCode.

| Existing V2 setting | Required edit |
|---|---|
| `backgroundJobs.mode: "managed"` | Choose `"native"` for Slim's thin task controls and session presets, or `"off"` for unwrapped native delegation without Slim task tools or session bindings. An omitted mode selects `"native"`. |
| `backgroundJobs.concurrency` | Remove the entire object, including empty objects and all-zero limits. Slim no longer enforces these admission caps on V2. |
| `backgroundJobs.wallClockTimeoutMs` | Remove it, including an explicit `0`. Slim no longer runs its wall-clock watchdog on V2. |
| `backgroundJobs.maxSessionsPerAgent` | Remove it, including the former default `2`. Slim no longer retains a reusable-session pool on V2. |
| `backgroundJobs.stopConfirmationMs` | Remove it, including the former default `5000`. Slim no longer runs a terminal gate on V2. |

An example V2 configuration after review is:

```jsonc
{
  "backgroundJobs": { "mode": "native" }
}
```

These removals do not provide equivalent host limits. Review any requirement
for concurrency, deadlines or session retention against your OpenCode host
before upgrading.

Remove `orchestratorWake`, `childInputWake`, `childInputWakeKinds`,
`waitForUserGuard`, `pruneEvictedSessions`, and `sameProviderPolicy` from
`backgroundJobs` after review. Slim ignores these former managed lifecycle
settings and warns for each configuration file that declares them.

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
host UI. The pre-existing child `task_report` queues an update with
`delivery: "queue"` and `resume: false`; it does not wake the parent.

Native restart recovery is owned by OpenCode and can repeat external effects.
It does not provide exactly-once execution. See
[Background Orchestration](background-orchestration.md) for the lifecycle and
[Tools](tools.md#background-task-control) for the control surface.
