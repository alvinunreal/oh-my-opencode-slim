# Installation Guide

The current source requires **OpenCode 2.3.0 or newer**. Published npm tags can
lag `master`; use a local checkout when testing unreleased changes.

## For Humans

### Quick Install

```bash
bunx oh-my-opencode-slim@latest install
# Non-interactive installer:
bunx oh-my-opencode-slim@latest install --no-tui
```

The CLI is Node-compatible; `npx` also works. `--no-tui` selects the installer
interface, not the runtime `tui: false` setting.

Use `install --help` for all flags. Common options are
`--preset=<openai|opencode-go>` (default `openai`), `--dry-run` and `--reset`.
The installer generates both named presets; see the
[OpenAI](presets/openai-preset.md) and [OpenCode Go](presets/opencode-go-preset.md)
guides for current model mappings. OpenCode Go installation also enables a
vision-capable Observer because its default Orchestrator is text-only.

Existing Slim configuration is retained unless you explicitly use `--reset`.
Reset writes a `.bak` before replacing it; it is not a repair command for one
incorrect field. The installer adds the plugin in `opencode.json[c]`, generates
Slim configuration in the same user directory, and enables LSP only when the
host has no explicit `lsp` setting. `OPENCODE_CONFIG_DIR` selects that directory.

A `bunx` invocation using an exact version or a non-`latest` tag pins the resolved
package version in the host configuration. `npx` does not expose the original
request in its cache path, so its installer entry is unpinned.

### Authenticate and verify

Provider authentication is a user-interactive step:

```bash
opencode auth login
opencode auth list
opencode models
```

Inspect `oh-my-opencode-slim.json[c]`, choose models you actually have access to,
then start OpenCode. `/plugins` shows plugin activation errors. Ask the
Orchestrator to run a small delegation to verify your chosen agent/model rather
than relying on registration alone.

Bundled skills register in-process; they are not copied to your skills directory.
`disabled_skills` omits selected bundled skills, and a same-named user directory
skill overrides a bundled registration. See [Skills](skills.md).

Native `general`/`explore` replacement is a runtime choice. Set
`replaceBuiltinSubagents: false` to retain them; the installer does not need a
second agent-removal mechanism.

### Run from a checkout

```bash
git clone https://github.com/alvinunreal/oh-my-opencode-slim.git
cd oh-my-opencode-slim
bun install
bun run build
bun dist/cli/index.js install
```

Register the complete package directory, not a single `dist` file: builds use
relative ESM chunks and optional dependencies. Update with `git pull`,
`bun install` and `bun run build`, then restart/reload OpenCode.

### Ask another coding agent

```text
Install and configure oh-my-opencode-slim using its Installation Guide:
https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/docs/installation.md
```

## For LLM Agents

1. Check `opencode --version` against the required host floor.
2. Read existing configuration; use `--dry-run` when needed and do not reset
   customized configuration without approval.
3. Run the installer with the requested preset/interface.
4. Give the user concrete authentication steps. Do not run an interactive login
   or expose stored credentials on their behalf.
5. Run `oh-my-opencode-slim doctor` from the project and verify a small native
   delegation with an available model.

Model lineups, feature disables, permissions and prompt overrides belong in
[Configuration](configuration.md), not a second installer-specific schema.

## Upgrading

Upgrade OpenCode before loading a source version that requires a newer host:

```bash
npm install -g @opencode/cli@latest
opencode --version
```

Use the equivalent command from your package manager when appropriate. Current
Slim code has no OpenCode 1 runtime; finish managed work before changing to the
native lifecycle.

Review **every inherited configuration layer**, including `OPENCODE_CONFIG_DIR`,
JSONC files that take precedence, ancestor `.opencode` directories and
`~/.opencode` for projects under `$HOME`. Run `oh-my-opencode-slim doctor` from
each project. The [discovery rules](configuration.md#config-files) apply to both
runtime and diagnostics.

OpenCode now owns child execution, same-session continuation, steering, durable
Jobs, restart recovery and completion notifications. Slim has no job board,
short aliases, reusable-session pool, periodic idle TODO scheduler or managed
limits. The default task mode is `native`; `off` removes Slim task tools and
session-preset routing by default. `sessionPresetRouting` remains independently
selectable.

| Older setting | Current behavior |
|---|---|
| `backgroundJobs.mode: "managed"` | Existing loader applies `native` with a warning; choose `off` if no Slim task controls are wanted |
| `backgroundJobs.enabled: false` without `mode` | Existing loader preserves the opt-out as `off`, with a warning |
| Positive `backgroundJobs.concurrency` limits | Startup refused: Slim cannot enforce them on the native host |
| Positive `backgroundJobs.wallClockTimeoutMs` | Startup refused for the same reason |
| Old board/reuse/wake/deadline settings | Removed; no equivalent plugin mechanism is created |
| Root `webfetch` block | Removed; use `disabled_tools: ["webfetch"]` to retain native fetch only |
| Disabled `auto-update-checker` hook | Removed; use `autoUpdate: false` |
| `fallback.continuationPolicy`, `fallback.initialRetryDelayMs` | Startup refused: neither controls native V2 fallback; remove the keys, even with task mode/hook off |

Explicit host limits are checked before merging, even if a closer layer selects
`off`. Errors name the source file and setting. For example:

```text
<config path>: Unsupported backgroundJobs.concurrency.providerConcurrency.openai = 2 on OpenCode v2: Slim no longer enforces this limit. Remove the key or set it to 0, then run /reload.
```

When activation is refused, use `/plugins` → view error or `doctor`, correct the
named file and `/reload`. Disabled features and invalid limits are different:
a nearer override must not conceal an unenforceable promise.

### Existing work and recovery

Old Slim board/delivery records are left unread and unchanged. The plugin does
not import them into native Jobs or delete them. Exact host sessions remain in
OpenCode; continue a known child with native `subagent(sessionID, prompt)`.
Old aliases are not native session IDs.

Host recovery is **at-least-once**, not exactly-once for external side effects.
An uncertain submission can still have landed; do not blindly resend it.
Standalone embeddings that do not run the host recovery sweep do not gain one
from Slim. See [Background Orchestration](background-orchestration.md).

## Troubleshooting

| Symptom | Check |
|---|---|
| Installer failure | `install --help`, writable configuration paths and dependency installation |
| Existing configuration message | Keep it, or explicitly choose `--reset`; do not confuse it with activation failure |
| Agent does not answer | `opencode auth list`, available models, `/plugins`, and project `doctor` output |
| Missing Slim task tools | Host floor, `backgroundJobs.mode`, and `disabled_tools`; native subagents work in `off` too |
| Local build loads but HTML extraction fails | Optional `jsdom` dependency must resolve from the package directory |
| Panes do not open | Use the shared service or an explicit `--server`; `--standalone` does not support Slim panes |

For pane deployment, authentication and backend setup use
[Multiplexer Integration](multiplexer-integration.md), not old `--port` or
background-subagent environment recipes.

Editor autocomplete uses the version-appropriate generated schema:

```jsonc
{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json"
}
```

For an unreleased checkout, use its local generated schema instead of an older
published tag. For consumed host contracts and verification, see the
[OpenCode 2 adapter](../src/v2/codemap.md).

## Uninstallation

1. Remove Slim from native `opencode.json[c]` `plugins` and, if separately
   registered, from `tui.json` `plugins`. Honor `OPENCODE_CONFIG_DIR`.
2. Remove Slim configuration only if no longer needed. Review `.jsonc`, `.json`
   and backups rather than deleting customized data indiscriminately.
3. Bundled skills disappear with the plugin. Review any old copied skills under
   the user skills directory; remove only copies you no longer use.
4. Older installers may have written `agent.general`/`agent.explore` disables
   or shell exports for `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` and
   `OPENCODE_ENABLE_EXA`. Remove installer-owned entries if no longer wanted.
   Runtime replacement stops when the plugin is absent.
5. Remove optional Companion assets only if unwanted; see
   [Companion](companion.md) for its paths. Leave shared host session storage
   and credentials alone.

Restart OpenCode and verify that Slim is no longer listed in `/plugins` and its
agents/commands are absent. Authentication status is not a plugin inventory.
