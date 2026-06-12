# Desktop Companion App

The desktop companion app provides a floating status overlay showing running and active agents.

## How to Enable in Configuration

You can enable the companion by adding a `companion` section to your setting configuration file (`~/.config/opencode/oh-my-opencode-slim.json` or `.opencode/oh-my-opencode-slim.json`):

```jsonc
{
  "companion": {
    "enabled": true,
    "position": "bottom-right",
    "size": "medium"
  }
}
```

### Supported Position & Size Values

- **`companion.position`**:
  - `bottom-right` (default)
  - `bottom-left`
  - `top-right`
  - `top-left`

- **`companion.size`**:
  - `small` (80px)
  - `medium` (120px) (default)
  - `large` (160px)

---

## Installer Flag

During interactive installation, the installer asks whether to download and
enable the native Companion binary. The prompt defaults to `yes`, so pressing
Enter installs it.

Companion installation is best-effort. If the binary cannot be downloaded or
installed, the installer prints a warning and continues installing the core
plugin without Companion enabled.

For automation, pass `--companion=yes` to install without prompting:

```bash
bunx oh-my-opencode-slim install --companion=yes
```

Pass `--companion=no` to skip the native binary and omit the config block.

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

If the binary is not located in this directory, the plugin runtime will not start the companion window.

---

## V2 Release Strategy

For the desktop companion app, the release workflow follows the V2 distribution
plan:

1. **GitHub Release Assets**: companion binaries are uploaded to the
   `companion-v0.1.0` GitHub release.
2. **Separate Companion Versioning**: the companion uses its own version so the
   plugin can ship beta updates without rebuilding native binaries every time.
3. **OS/Arch Detection**: `--companion=yes` selects the archive for the current
   target.
4. **No R2 Required**: GitHub Releases are the source of truth. R2 can be added
   later as a mirror if download volume becomes a problem.

Current release assets are named:

```text
oh-my-opencode-slim-companion-v0.1.0-aarch64-apple-darwin.tar.gz
oh-my-opencode-slim-companion-v0.1.0-x86_64-apple-darwin.tar.gz
oh-my-opencode-slim-companion-v0.1.0-x86_64-unknown-linux-gnu.tar.gz
oh-my-opencode-slim-companion-v0.1.0-aarch64-unknown-linux-gnu.tar.gz
oh-my-opencode-slim-companion-v0.1.0-x86_64-pc-windows-msvc.zip
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
0.1.0
```

The matching GitHub release tag is:

```text
companion-v0.1.0
```

The installer currently downloads from that tag.

### 2. Trigger selected target builds manually

Build only the targets you want to pay for. Start with your current platform if
you are testing the release path:

```bash
gh workflow run companion-release.yml \
  -f version=0.1.0 \
  -f targets=macos-arm64
```

Build multiple targets by passing a comma-separated list:

```bash
gh workflow run companion-release.yml \
  -f version=0.1.0 \
  -f targets=macos-arm64,macos-x64,linux-x64,windows-x64
```

Supported workflow target names:

```text
macos-arm64
macos-x64
linux-x64
windows-x64
```

The workflow creates or updates the `companion-v<version>` release and uploads
the selected archives.

### 3. Verify release assets

After the workflow finishes:

```bash
gh release view companion-v0.1.0
```

Confirm the release contains the archive names expected by the installer for the
targets you built.

### 4. Install with the plugin installer

Once the release assets exist, users can run:

```bash
bunx oh-my-opencode-slim@beta install --companion=yes
```

The installer detects the user's OS/architecture, downloads the matching archive
from `companion-v0.1.0`, installs it to the runtime binary path, and writes the
companion config block. If the companion install fails, the core plugin install
continues without enabling Companion.

### Cost controls

- The workflow uses `workflow_dispatch` only. It never runs on push, PR, or tag.
- Build a single target while testing.
- Reuse one companion release across many plugin betas.
- Add more targets only when you are ready to support those users.
