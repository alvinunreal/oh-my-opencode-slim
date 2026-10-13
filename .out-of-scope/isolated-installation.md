# Isolated Installation Mode & Dedicated Launcher CLI

This project does not provide an `--isolated` installer flag, a bundled custom launcher binary, or custom configuration directory namespaces.

## Why this is out of scope

The installer (`src/cli/install.ts`) configures OpenCode to load the plugin by adding an entry to `~/.config/opencode/opencode.json`. It was proposed to introduce an isolated installation mode (e.g. `--isolated`), install configs to a separate namespace like `~/.config/ohmyocs/`, and generate a dedicated shell launcher wrapper (`~/.local/bin/ohmyocs` or an `omo-switch` CLI).

This was rejected as unnecessary complexity because OpenCode and the environment already provide this capability out of the box:

- OpenCode natively respects the `OPENCODE_CONFIG_DIR` environment variable:
  ```bash
  OPENCODE_CONFIG_DIR=~/.config/ohmyocs opencode
  ```
- This separates configuration files without modifying the default `~/.config/opencode/` directory or requiring custom code in the plugin installer. It does not isolate all plugin state: saved session-board state still uses `XDG_DATA_HOME`, and cached plugin packages still use `XDG_CACHE_HOME`.
- Adding custom installer flags, prompts, path-aliasing logic, and wrapper binaries introduces moving parts and shell maintenance overhead that duplicate standard Unix environment variable mechanisms.

Users who want isolated profiles or multiple parallel configurations can use `OPENCODE_CONFIG_DIR` in shell aliases or wrapper scripts.

## Prior requests

- #102 — "Feature Request: Isolated Installation Mode" (closed as wontfix)
- #495 — "CLI tool for switching between oh-my-openagent and oh-my-opencode-slim" (closed as wontfix)
