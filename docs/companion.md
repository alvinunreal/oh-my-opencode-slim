# Desktop Companion App

The desktop companion app provides a floating status overlay showing running and active agents.

Hover an active agent tile to inspect the live provider/model recorded for that
session. A variant is shown only when it was observed on the live
`chat.message` selection; model-only telemetry never guesses a variant from
the agent configuration. The Companion therefore avoids presenting a configured
default as if it were the user's current runtime choice.

Attention in this PR is intentionally limited to waiting-for-input. A pending
question or permission receives an outline that stays visible until the explicit
reply/reject path resolves it. Error attention is deliberately deferred: raw
`session.error` is not reliable terminal evidence because foreground/model
fallback can still recover the turn, and the Companion should not duplicate the
fallback subsystem's terminalization state machine.

When the selected session receives a new `waiting-input` request, the plugin
increments a monotonic `attention_seq`. The native Companion requests
informational user attention once for each `(session_id, attention_seq)` pair.
This keeps repeated questions distinct even when a fast
`resolved → waiting-input` transition is coalesced by the file watcher.
The generation and last request identity are recovered from shared state when
the plugin replaces a manager for the same session, so re-initialization cannot
reuse a native attention key. Returning to an ordinary state resets the native
attention request. The effect
is delegated to the platform/window manager (for example taskbar flashing or
Dock attention); unsupported environments may safely ignore it. Error/failure
notifications are intentionally not emitted because the parent status PR does
not claim canonical settled terminal evidence.

Right-click the Companion to open its compact control menu. When the menu is
closed, the displayed project continues to follow live agent activity. Opening
the menu pins the currently displayed project so background activity in another
repository cannot change the target while you are editing it. The first menu row
cycles across every live project, even when that project is currently idle.

The preset row always applies to that explicitly selected project. Its center
button shows a readable scoped value such as `Prj:Inherit` or `Gbl:openai`;
clicking it toggles between **Project** and **Global** scope. If a project has
not published preset state yet, the menu shows a disabled diagnostic row instead
of silently hiding the controls.

Project scope is the safe default for desktop use with multiple projects open.
It always writes the current project's `.opencode` layer, creating the
canonical `oh-my-opencode-slim.jsonc` file when necessary. Project navigation
also includes **Inherit**, which removes only the local `preset` key so the
project follows the next inherited selection: an eligible ancestor pin, or the
global selection when no ancestor pins a preset. Environment preset overrides
still take precedence. The result message identifies the actual inherited
selection, and shared ancestor files are never modified.

When `OPENCODE_DISABLE_PROJECT_CONFIG` is enabled, Project preset writes and
Inherit actions are rejected rather than reporting changes that reload would
ignore. Global scope remains available.

Global scope writes only the user/global config and offers only presets defined
in that global layer. Projects with local overrides remain unchanged, while
other open projects pick up the new global selection through the existing
Companion refresh path.

Preset changes are sent back to the plugin over the Companion state channel; the
native binary never parses or edits OMO configuration files directly. While a
request is pending, preset controls stay disabled until either a matching
completion appears in any live session or the request's target session
disappears. Target loss therefore recovers without a Companion restart and is
not misreported as success. Request execution is fenced by request ID: once a
request has been applied, a stale queue entry left by an acknowledgement write
failure is only re-acknowledged, never re-applied. The completion ID is also
recovered from shared state across a plugin restart when persistence succeeded.

The same compact menu also exposes project-folder actions without an OpenCode
host dependency: **Open** launches the exact session `cwd` in the platform file
manager, while **Copy** places that exact path on the system clipboard. The
file-manager launcher is waited on in a background worker so it cannot leave a
zombie child or block the Companion UI. Open status is scoped to the selected
session; completion never closes a subsequently opened menu. Spawn/non-zero-exit
failures stay inside the existing compact row as a red **!Open** button with the
detailed error on hover, including at the smallest Companion size. The
actions use only the directory already published by session state; they do not
guess repository roots or scan the filesystem.

## How to Enable in Configuration

You can enable the companion by adding a `companion` section to your setting configuration file (`~/.config/opencode/oh-my-opencode-slim.json` or `.opencode/oh-my-opencode-slim.json`):

```jsonc
{
  "companion": {
    "enabled": true,
    "binaryPath": "/path/to/oh-my-opencode-slim-companion",
    "position": "bottom-right",
    "size": "medium",
    "gifPack": "default",
    "loopStyle": "classic",
    "speed": 1,
    "debug": false
  }
}
```

### Supported Values

- **`companion.position`**:
  - `bottom-right` (default)
  - `bottom-left`
  - `top-right`
  - `top-left`

- **`companion.size`**:
  - `small` (80px)
  - `medium` (120px) (default)
  - `large` (160px)

- **`companion.gifPack`**:
  - `default` (default) - the bundled companion animation set generated from
    tracked MP4 sources in `companion/VIDEOS/`. See
    [source-video README](../companion/VIDEOS/README.md) for mappings and
    regeneration instructions.

- **`companion.loopStyle`**:
  - `classic` (default) - forward playback that loops back to the first frame.
  - `smooth` - ping-pong playback that reverses direction at the end for a
    smoother transition.

- **`companion.speed`**: optional animation playback speed multiplier from `0.25` to
  `4`. The default is `1`. Values above `1` play faster; values below `1`
  play slower.

- **`companion.debug`**: set to `true` to enable verbose native companion debug
  logs while troubleshooting window/session behavior. Logs are written under
  `$XDG_DATA_HOME/opencode/log/` or `~/.local/share/opencode/log/`.

- **`companion.binaryPath`**: optional path to a custom companion binary. When
  set, the runtime launches this binary instead of the default install path.
  Custom binaries are user-managed and are not replaced by automatic companion
  updates.

### Remembered Window Position

You can drag the companion window to a custom location. The companion remembers
the last dragged position per project and restores it the next time that project
opens. If no custom position is saved for a project, the configured
`companion.position` corner is used.

Saved positions are clamped to the current screen so the companion stays visible
after monitor or resolution changes. Position persistence runs off the native UI
thread; a busy shared-state lock therefore cannot freeze animation or dragging.
The in-memory position remains authoritative while a delayed write is retried.

---

## Installer Flag

During interactive installation, the installer asks whether to download and
enable the native Companion binary. The prompt defaults to `no`, so pressing
Enter skips it.

On niri, Companion can install normally when enabled now that the native binary
is fixed.

Companion installation is best-effort. If the binary cannot be downloaded or
installed, the installer prints a warning and continues installing the core
plugin without Companion enabled.

For automation, pass `--companion=yes` to install without prompting:

```bash
bunx oh-my-opencode-slim install --companion=yes
```

Pass `--companion=no` to skip the native binary and omit the config block.

## niri support status

The native `companion-v0.1.3` binary works on niri and exposes a stable
Wayland app-id/title: `oh-my-opencode-slim-companion`.

niri users who want the Companion to behave like an overlay should add a window
rule to their niri config, for example:

```kdl
window-rule {
    match app-id=r"^oh-my-opencode-slim-companion$"
    match title=r"^oh-my-opencode-slim-companion$"
    open-floating true
    open-focused false
    default-floating-position x=16 y=16 relative-to="bottom-right"
}
```

The rule is optional, but without `open-floating true` niri may tile the
Companion like any other regular xdg-toplevel window. Adjust the `x`/`y` gap or
`relative-to` corner if you prefer a different placement.

Run diagnostics with:

```bash
oh-my-opencode-slim doctor
```

---

## Expected Binary Install Path

The runtime looks for the companion binary at:

```text
$XDG_DATA_HOME/opencode/storage/oh-my-opencode-slim/bin/oh-my-opencode-slim-companion
```

If `XDG_DATA_HOME` is unset, this resolves to:

```text
~/.local/share/opencode/storage/oh-my-opencode-slim/bin/oh-my-opencode-slim-companion
```

If the binary is not located in this directory, set `companion.binaryPath` to
the binary you want the plugin runtime to launch.

When Companion is enabled and uses the default install path, the plugin keeps
the native binary aligned with the companion version bundled by the installed
plugin package. The updater writes install metadata beside the binary so future
starts can skip unnecessary downloads. Existing `companion-v0.1.2` installs that
predate metadata are migrated in place without re-downloading.

Startup checks run before the Companion is spawned, but they use a short timeout
so OpenCode startup is not blocked by a slow network. Plugin auto-update also
tries to update the Companion binary after the new package is installed. If a
download fails, the plugin update still succeeds and Companion update is retried
on the next OpenCode restart. The updater uses a lock to prevent concurrent
OpenCode processes from replacing the same binary, and stale locks from crashed
updates are cleaned up automatically.

Companion runtime state uses the same fail-closed principle. Each live project
gets a distinct manager identity within the OpenCode process, dead process
entries are pruned on writes, abandoned state locks are recovered, and the
native window is not spawned until its owner state has been published. A
temporarily busy state lock schedules a retry instead of blocking the plugin
thread.

Automatic native updates only use release archives listed in the packaged
companion manifest, and every archive must have a matching SHA256 checksum.
Custom binaries configured with `companion.binaryPath` are never overwritten.

---

## V2 Release Strategy

For the desktop companion app, the release workflow follows the V2 distribution
plan:

1. **GitHub Release Assets**: companion binaries are uploaded to the
   `companion-v0.1.3` GitHub release.
2. **Separate Companion Versioning**: the companion uses its own version so the
   plugin can ship beta updates without rebuilding native binaries every time.
3. **OS/Arch Detection**: `--companion=yes` selects the archive for the current
   target.
4. **Manifest + Checksums**: the plugin ships
   `src/companion/companion-manifest.json`, which names the companion release
   and SHA256 checksum for each supported archive.
5. **No R2 Required**: GitHub Releases are the source of truth. R2 can be added
   later as a mirror if download volume becomes a problem.

Current release assets are named:

```text
oh-my-opencode-slim-companion-v0.1.3-aarch64-apple-darwin.tar.gz
oh-my-opencode-slim-companion-v0.1.3-x86_64-apple-darwin.tar.gz
oh-my-opencode-slim-companion-v0.1.3-x86_64-unknown-linux-gnu.tar.gz
oh-my-opencode-slim-companion-v0.1.3-aarch64-unknown-linux-gnu.tar.gz
oh-my-opencode-slim-companion-v0.1.3-x86_64-pc-windows-msvc.zip
```

Supported installer targets:

- macOS arm64: `aarch64-apple-darwin`
- macOS x64: `x86_64-apple-darwin`
- Linux x64: `x86_64-unknown-linux-gnu`
- Linux arm64: `aarch64-unknown-linux-gnu`
- Windows x64: `x86_64-pc-windows-msvc`

## Maintainer Release Process

Companion binaries are **not** built on every plugin beta. The workflow is
manual-only so GitHub runner usage stays under maintainer control.

Run a companion release only when the Rust companion changes or when the state
protocol expected by the plugin changes.

### 1. Choose the companion version

The first companion release is:

```text
0.1.2
```

The matching GitHub release tag is:

```text
companion-v0.1.3
```

The installer currently downloads from that tag.

### 2. Trigger selected target builds manually

Build only the targets you want to pay for. Start with your current platform if
you are testing the release path:

```bash
gh workflow run companion-release.yml \
  -f version=0.1.3 \
  -f targets=macos-arm64
```

Build multiple targets by passing a comma-separated list:

```bash
gh workflow run companion-release.yml \
  -f version=0.1.3 \
  -f targets=macos-arm64,macos-x64,linux-x64,linux-arm64,windows-x64
```

Supported workflow target names:

```text
macos-arm64
macos-x64
linux-x64
linux-arm64
windows-x64
```

The workflow creates or updates the `companion-v<version>` release and uploads
the selected archives.

### 3. Verify release assets

After the workflow finishes:

```bash
gh release view companion-v0.1.3
```

Confirm the release contains the archive names expected by the installer for the
targets you built. Then update `src/companion/companion-manifest.json` with the
new version, tag, and each asset's SHA256 digest. GitHub release asset metadata
includes `digest: sha256:<hash>`, which can be copied into the manifest without
the `sha256:` prefix.

The runtime updater has a matching manifest constant in
`src/companion/updater.ts`; tests assert the JSON manifest and runtime constant
stay in sync.

### 4. Install with the plugin installer

Once the release assets exist, users can run:

```bash
bunx oh-my-opencode-slim@beta install --companion=yes
```

The installer detects the user's OS/architecture, downloads the matching archive
from `companion-v0.1.3`, installs it to the runtime binary path, and writes the
companion config block. If the companion install fails, the core plugin install
continues without enabling Companion.

### Cost controls

- The workflow uses `workflow_dispatch` only. It never runs on push, PR, or tag.
- Build a single target while testing.
- Reuse one companion release across many plugin betas.
- Add more targets only when you are ready to support those users.
