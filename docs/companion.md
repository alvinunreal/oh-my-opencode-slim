# Desktop Companion App

The desktop companion app provides a floating status overlay showing running and active agents.

Native source, media, builds, and releases live in the public
[oh-my-opencode-companion repository](https://github.com/alvinunreal/oh-my-opencode-companion),
with the Rust crate at its root. This plugin retains the TypeScript state
manager, installer/updater, CLI, and pinned release manifest. Binary/archive
names, `companion-vX.Y.Z` tags, configuration, and install paths are unchanged.

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

Right-click the Companion to open a **separate native control popup**, outside
the animation's window. The popup uses a compact scrollable layout, with a
**drag handle across its header** (left-click and drag to move just the popup)
and an **× close button at the upper-right**. The root animation window remains
in place. The popup starts hidden while its UI is prepared. On Windows, it also
waits for the native window and drawing area to reach their intended position
and size before appearing. Opening uses the click's physical desktop location
and the popup's own DPI scale, including UI zoom, so a different scale on the
primary monitor cannot place the menu on the wrong display. The menu fits within
the selected monitor's usable area, excluding taskbars. Once visible, it can be
dragged independently without snapping back to its opening position. It shows
full project names/paths, a search field, and a preset selector that fits the
available width. Long selected names are shortened visually; hover to read the
full name.

The popup has three project views:

- **Active:** live OpenCode project instances with work underway or waiting for
  input.
- **All open:** every project currently published by a live OpenCode plugin
  instance, including idle ones.
- **Known:** up to 64 previously seen project directories, recorded only when
  an actual OpenCode plugin instance runs there. Known does **not** scan the
  filesystem or infer a common project root. Entries may refer to projects
  whose OpenCode instance is no longer running.

Opening the popup pins the current animation session. Selecting a project for
preset editing **does not change the animation's session or window position**.
Clicking a project in the list changes only the editor target, and background
activity cannot steal that target until the menu is closed. If the selected
live project exits (or a remembered entry is evicted) while the menu remains
open, its identity is retained but preset editing is disabled with an explicit
warning. No request silently falls back to the displayed project. A project
with multiple OpenCode instances stays in Active while any one instance is
working or awaiting input. Press Escape, use Close, or move focus outside the
popup to dismiss it.

Choose the explicit **Project / Global** scope, then select a preset by name
from the dropdown. Project scope offers **Inherit**. When a remembered project
has no active OpenCode instance, a live TypeScript CompanionManager relays its
request to the registered directory; Rust never writes OMO config or JSONC.
Its last observed preset catalog may be stale, and the interface indicates
this. Nonexistent/unregistered folders and invalid configurations reject writes
and return feedback. A remembered project can be edited only while at least one
OpenCode instance is available to relay its request.

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
    "debug": false,
    "hideWhenIdle": false
  }
}
```

`companion.enabled` is also the cold-gate switch: when it is `false` (the
default), the plugin does not construct the Companion manager, start its
pollers, or write Companion state. Setting it to `true` enables the whole
surface; no code is removed.

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
    tracked MP4 sources in the native repository's `VIDEOS/`. See
    [source-video README](https://github.com/alvinunreal/oh-my-opencode-companion/blob/HEAD/VIDEOS/README.md) for mappings and
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

- **`companion.hideWhenIdle`**: set to `true` to hide the companion window while
  no agent is active instead of playing the idle animation. Requires companion
  v0.1.10 or later. While hidden, the right-click control popup, preset
  switching, and drag-to-reposition are unavailable until activity resumes, and
  a pending input request keeps the window visible. Default `false`.

- **`companion.binaryPath`**: optional path to a custom companion binary. When
  set, the runtime launches this binary instead of the default install path.
  Custom binaries are user-managed and are not replaced by automatic companion
  updates.

### Remembered Window Position

You can drag the companion window to a custom location. The companion remembers
the last dragged position per project and restores it the next time that project
opens. If no custom position is saved for a project, the configured
`companion.position` corner is used.

On Windows, native dragging preserves signed desktop coordinates for monitors
to the left of or above the primary display. Saved positions are checked against
the actual connected monitor rectangles, including negative virtual-desktop
origins, using the current DPI scale and UI zoom before restoring the native
window. Disconnected/off-screen coordinates fall back to a visible
anchor without overwriting the stored preference. Other platforms keep the
existing position-restoration behavior. Position persistence runs off the native
UI thread; a busy shared-state lock therefore cannot freeze animation or dragging.
The in-memory position remains authoritative while a delayed write is retried.

---

## Installing

Companion is installed separately from the plugin. Run the regular installer
first, then:

```bash
bunx oh-my-opencode-slim companion install
```

The command downloads the native binary for the current OS/architecture and
sets `"companion": { "enabled": true }` in the existing
`oh-my-opencode-slim.json(c)`, keeping any other companion settings and
comments. It exits with an error if no plugin config exists yet. Pass
`--dry-run` to print the target, archive URL, and paths without writing
anything. Restart OpenCode to launch Companion.

On niri, Companion installs normally now that the native binary is fixed.

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

Native release automation in the standalone repository builds all five platform
archives independently of plugin releases. This plugin's scheduled/manual
manifest-sync workflow reads those public releases, hashes all downloaded
archives, and proposes a plugin-only manifest PR. `npm version` and `npm publish`
verify the pinned remote release identity and archive checksums, independently
of the offline manifest consistency check. After the manifest PR is merged and
a new npm plugin release is published, managed installs update without manual
`.exe` or `.exe.json` manipulation. See [release process](release.md).

---

## Release strategy

Companion binaries are released separately from the plugin, as GitHub Release
assets in the native repository. See
[release](release.md#companion-release-strategy) for asset names, supported
targets, and the manifest-sync workflow.
