# OpenCode V2 native lifecycle upgrade

The V2 managed-lifecycle retirement is a breaking change for the next major
plugin release. It must not ship in a 3.x patch or minor release. The maintainer
chooses the release version and publishes the upgrade notice before release;
this change does not bump or publish the package.

OpenCode **2.3.0+** is required on V2: native subagents always run in the
background and the host reports every settled child period
([release](https://github.com/anomalyco/opencode/releases/tag/v2.3.0),
[changelog](https://opencode.ai/changelog/v2.3.0)). Parseable versions
below stable 2.3.0 (including `2.3.0-dev`) fail setup with upgrade guidance.
Unversioned embeddings cannot be checked and must provide the same host
behavior. V1 is unchanged.

On V2, the default changes from `managed` to `native`, even when no
`backgroundJobs` configuration is present. Slim's job board, short aliases,
reusable-session pool and managed limits stop applying; OpenCode owns child
execution, continuation, persistence, restart recovery and completion
notifications. V1 keeps its managed lifecycle and existing configuration.

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
version. When it detects OpenCode v2, it reports incompatible settings in
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
before upgrading. If the same user configuration serves V1 and V2, keep
V1-only lifecycle settings out of every configuration layer V2 discovers.

`orchestratorWake`, `childInputWake`, `childInputWakeKinds`, `waitForUserGuard`,
`pruneEvictedSessions`, and `sameProviderPolicy` remain supported for V1
managed mode only. Explicit V2 values warn and have no effect; remove them
from V2 configuration after review. Warnings include each source layer, so an
inherited key can appear more than once.

The unrelated disable switches `autoUpdate: false`,
`webfetch.enabled: false`, and `backgroundJobs.childInputWake: false` remain in
the schema with their existing layered precedence. This retirement does not
remove or rename those controls. V2 has no Slim child-input wake scheduler;
V1 still honors the configured switch.

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
