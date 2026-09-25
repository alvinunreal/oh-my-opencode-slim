# Agent Marketplace

Marketplace packages provide optional agents that are registered when an
OpenCode session starts. A package is **installed** in the local store and
separately **activated** by listing its canonical ID in the active preset.
Installing from the registry via the CLI performs both steps; importing a
local file, or installing via the in-session tool, does not activate it.

Package IDs use `publisher/package` (for example, `example/reviewer`).
Registry install can select a specific version with
`publisher/package@1.2.3`; updates target an already installed package.
Package versions are exact semantic versions. The local store lives under
`${XDG_DATA_HOME:-~/.local/share}/opencode/storage/oh-my-opencode-slim/marketplace/`
and keeps a lockfile and package snapshots. You do not need a network
connection to start OpenCode with already installed packages: startup reads
the local store, checks installed packages and their required capabilities,
and skips invalid/unavailable agents with diagnostics rather than fetching
from the registry. Registry traffic occurs only for an explicit install or
update, not for `list`, `show`, `verify`, `status`, or startup.

## CLI lifecycle

Run from the project whose plugin config you want to change (or from any
directory if using only the user config). Replace example IDs and paths with
real packages:

```bash
bunx oh-my-opencode-slim marketplace install publisher/package
bunx oh-my-opencode-slim marketplace list
bunx oh-my-opencode-slim marketplace show publisher/package --json
bunx oh-my-opencode-slim marketplace verify publisher/package --json
bunx oh-my-opencode-slim marketplace status --json

bunx oh-my-opencode-slim marketplace update publisher/package
bunx oh-my-opencode-slim marketplace disable publisher/package
bunx oh-my-opencode-slim marketplace enable publisher/package
bunx oh-my-opencode-slim marketplace remove publisher/package
```

| Command | Effect |
|---------|--------|
| `install <publisher/package[@version]>` | Downloads from the default HTTPS registry, stores the package, **enables it in the active preset**. Requires a selected, existing preset and writable plugin config. |
| `import <file.json> [--update]` | Installs a package bundle from a local JSON file. Does **not** enable it; `--update` replaces an already installed package. |
| `list` / `show <id> [--json]` | Lists installed packages or displays one stored package (including its source). Only `show` accepts `--json`. |
| `verify [id] [--json]` | Checks stored package integrity (all packages if ID omitted); returns a nonzero exit code if any check fails. |
| `update <id>` | Fetches a registry version of an already installed ID and updates the stored package. Does not change activation. Local file updates use `import <file> --update` instead. |
| `enable <id>` / `disable <id>` | Adds/removes an installed package ID from the active preset's activation list. Disabling does not uninstall the package. |
| `remove <id>` | Uninstalls the package and removes references from all presets in the user and current project plugin config files. |
| `status [--json]` | Reports installed, configured and diagnostic state; CLI cannot compare with a live in-session registry, so its comparison is `unavailable`. |

To import locally, put a valid package bundle (a JSON object with a
`manifest` property) on disk, then run:

```bash
bunx oh-my-opencode-slim marketplace import ./reviewer.json
bunx oh-my-opencode-slim marketplace enable publisher/reviewer
```

`import` takes a filesystem path, not a registry ID. `install`/`update` take a
registry package ID, not a path. Use `show` to inspect the stored manifest and
source, `verify` to check the lockfile/package digest, and `status` to inspect
activation. Downloads try the v3 registry first. Only if it is unavailable or
the package is not found there do they try the v2 registry; validation,
integrity, or compatibility errors do **not** silently fall back to v2. An
explicit version can be used on install when the registry offers it. Local
import supports both v2 and v3 package manifests.

After a successful CLI mutation, the CLI attempts to restart an **active
OpenCode v2 managed service** using `opencode service status` and
`opencode service restart`. A successful restart is reported as
`reload_status: reloaded`. A stopped service reports `pending` (next launch);
unsupported host versions report `unsupported`; a missing/unreachable service
or failed restart reports `unavailable`. The saved mutation is not rolled back
if the restart fails. The CLI does not restart an OpenCode v1 service. If the
current client still has a previous agent snapshot, reload OpenCode or open a
new session; no operation hot-swaps the existing agent registry.

## Preset activation and editing

The normal, installer-generated preset format is **flat**. Existing agent
entries stay beside `marketplace`; there is no migration to an `agents`
wrapper:

```jsonc
{
  "preset": "work",
  "presets": {
    "work": {
      "oracle": { "model": "openai/gpt-6-astra" },
      "marketplace": { "agents": ["publisher/reviewer"] }
    }
  }
}
```

A preset can also contain only `marketplace` (for activation with the default
agent setup). The optional structured form uses
`"agents": { "oracle": { ... } }` alongside `marketplace`; both forms are
accepted. A child preset can inherit normal agents and activation from a
single parent using `extends`:

```jsonc
{
  "presets": {
    "base": {
      "oracle": { "model": "openai/gpt-6-astra" },
      "marketplace": { "agents": ["publisher/reviewer"] }
    },
    "no-marketplace": {
      "extends": "base",
      "marketplace": { "agents": [] }
    }
  }
}
```

Omitting `marketplace.agents` inherits the parent's list. An explicit `[]`
clears it. A child's list **replaces**, rather than appends to, its parent's
list. User and project preset layers merge in the same way: an explicit list
in the project config replaces the user list, while unrelated agent entries
remain. Root `agents` overrides and host config still take precedence over
normal preset agent settings; see [Configuration](configuration.md#preset-inheritance).

CLI `enable`/`disable` edits the active preset in the current project plugin
config when present, otherwise in the user plugin config. It retains existing
flat agent entries; activation-only and structured presets remain valid after
editing. Reads accept `.json` and `.jsonc`, but mutations serialize the full
file as JSON (comments and formatting in `.jsonc` are lost); the writer creates
a `.bak` backup. `remove` cleans up references in both available config files
for the current project. A package can remain installed but disabled in a
preset, and a different preset can enable it independently.

## In-session tool and status

The Orchestrator has a `marketplace` tool. For example, install with:

```json
{ "action": "install", "packageId": "publisher/reviewer" }
```

The tool's `install` **only installs**; `enable` is a separate action. This is
different from CLI `install`, which enables in the active preset. For local
files use `{ "action": "import", "path": "./reviewer.json" }`, optionally
adding `"update": true` when replacing an already installed package. Paths
relative to the tool's project directory work; use `packageId` for remote
`install`/`update` and local `show`/`enable`/`disable`/`remove`. `list` and
`status` need no other arguments (for example `{ "action": "status" }`);
`verify` can take an optional `packageId`.
Only Orchestrator sessions may use the tool; a configured permission can deny
it. Tool mutations save to disk but **never restart the service or hot-swap**
agents in the current session.

In-session `status` shows installed packages, the active preset's configured
IDs, currently live packages, and diagnostics labeled `disk` or `live`. Its
`reload_status` is `applied` when the desired and live agent identities match,
`pending` when they differ, or `unavailable` when the comparison cannot be
made. A saved change can therefore remain `pending` until OpenCode reloads
or a new session starts. CLI `status` does not have a live registry snapshot:
`unavailable` there does not mean the install failed. `verify` checks local
integrity, not whether an agent is active. Diagnostics can identify missing,
corrupt, incompatible, colliding, or missing-dependency packages.

Activation checks required skills and MCPs before registering an agent. On
OpenCode v2, configured MCPs are checked under `mcp.servers`; entries marked
`disabled: true` and invalid definitions (including invalid
`timeout.startup`/`timeout.request`) do not count as available. Slim's own
MCPs count only when its MCP transform registration succeeds. An MCP supplied
solely by another plugin's transform does not count unless it is also in the
configured MCP snapshot. A host may defer a transform callback or later fail
MCP registration:
those later failures cannot revoke an already finalized agent registry.
Resolve missing MCPs and reload. If required MCP names produce overlapping
permission action namespaces after non-alphanumeric characters are sanitized
to `_`, activation is refused with an `ambiguous-mcp-namespace` diagnostic;
rename/adjust the MCP configuration and reload rather than relying on an
ambiguous permission grant.
