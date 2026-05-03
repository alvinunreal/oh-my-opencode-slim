# Divoom MiniToo Display Integration

oh-my-opencode-slim can mirror agent activity to a Divoom MiniToo Bluetooth
display. The integration is optional and disabled by default.

## Demo

https://github.com/user-attachments/assets/938c673b-f900-42fa-8131-b69d793b1440


## What it shows

When enabled, the plugin sends bundled GIFs as OpenCode changes state:

| OpenCode state | Divoom display |
|----------------|----------------|
| Plugin loaded | `intro.gif` |
| Orchestrator is busy planning or working directly | `orchestrator.gif` |
| A delegated agent starts | that agent's GIF |
| Multiple agents run in parallel | first delegated agent keeps the display |
| Delegated agents finish but orchestrator is still working | `orchestrator.gif` |
| Orchestrator becomes idle again | `intro.gif` |
| Permission prompt or question needs a reply | `input.gif` |

Bundled GIFs currently cover `orchestrator`, `explorer`, `librarian`, `oracle`,
`designer`, `fixer`, `council`, `input`, and `intro`. You can configure
`divoom.gifs.input` to customize user-input waits; if `input.gif` is not present
yet, the plugin falls back to `intro.gif`.

## Prerequisites

This plugin does not talk to the Bluetooth device directly. It shells out to the
Divoom MiniToo macOS sender/daemon tooling from:

https://github.com/alvinunreal/divoom-minitoo-osx

Before enabling the plugin integration:

1. Install the Divoom MiniToo macOS app/tooling from that repository.
2. Pair the Divoom MiniToo with macOS.
3. Disconnect the normal macOS audio profile once so the daemon can claim the
   RFCOMM app channel.
4. Start the Divoom daemon.
5. Confirm the bundled sender works manually.

The important operational detail: the daemon should stay running. Once it holds
the RFCOMM channel open, plugin-triggered GIF sends should not need repeated
Bluetooth disconnect/reconnect cycles.

## Start the Divoom daemon

Follow the current instructions in
[`divoom-minitoo-osx`](https://github.com/alvinunreal/divoom-minitoo-osx). The
validated flow is:

```bash
# From the divoom-minitoo-osx checkout/app resources, disconnect audio once.
blueutil --disconnect <DIVOOM_BLUETOOTH_ADDRESS> || true

# Start the daemon on RFCOMM channel 1 / localhost port 40583.
tools/divoom-daemon <DIVOOM_BLUETOOTH_ADDRESS> 1 40583
```

If you are using the packaged MiniToo app bundle, use its daemon/menu-bar start
flow instead. The key is the same: disconnect the audio profile if normal daemon
startup fails, then start the daemon and leave it running.

## Manual sender smoke test

Before blaming OpenCode, verify the Divoom sender works directly:

```bash
"/Applications/Divoom MiniToo.app/Contents/Resources/.venv/bin/python" \
  "/Applications/Divoom MiniToo.app/Contents/Resources/tools/divoom_send.py" \
  "/path/to/test.gif" \
  --size 128 \
  --fps 8 \
  --speed 125 \
  --max-frames 24 \
  --posterize-bits 3 \
  --out-dir ~/.local/share/opencode/storage/oh-my-opencode-slim/divoom/captures
```

**Note:** The sender must support the `--out-dir` flag. This requires a recent
version of the Divoom MiniToo sender (the plugin uses this for temporary
processing files).

If that updates the display, the OpenCode integration should work once enabled.

**Output directory path:** The plugin writes temporary processing files to
`$XDG_DATA_HOME/opencode/storage/oh-my-opencode-slim/divoom/captures` when
`XDG_DATA_HOME` is set to a non-empty absolute path. Otherwise it falls back to
`~/.local/share/opencode/storage/oh-my-opencode-slim/divoom/captures`.

## Enable in oh-my-opencode-slim

Open your plugin config:

```text
~/.config/opencode/oh-my-opencode-slim.json
```

Add:

```jsonc
{
  "divoom": {
    "enabled": true
  }
}
```

Then rebuild/restart OpenCode if you are running from a local checkout.

For one-off runs, you can enable Divoom without changing your config:

```bash
OH_MY_OPENCODE_SLIM_DIVOOM=1 opencode
```

Accepted truthy values are `1`, `true`, `yes`, and `on`. The environment
variable force-enables Divoom for that run, even if `divoom.enabled` is `false`
in config.

## Tunable settings

The defaults target the macOS Divoom MiniToo app bundle:

```jsonc
{
  "divoom": {
    "enabled": true,
    "python": "/Applications/Divoom MiniToo.app/Contents/Resources/.venv/bin/python",
    "script": "/Applications/Divoom MiniToo.app/Contents/Resources/tools/divoom_send.py",
    "size": 128,
    "fps": 8,
    "speed": 125,
    "maxFrames": 24,
    "posterizeBits": 3
  }
}
```

You can also override individual GIFs with either bundled filenames or absolute
paths:

```jsonc
{
  "divoom": {
    "enabled": true,
    "gifs": {
      "oracle": "/Users/me/Pictures/oracle.gif",
      "fixer": "fixer.gif"
    }
  }
}
```

## Troubleshooting

- **Nothing changes on the display:** run the manual sender smoke test first.
- **Daemon cannot open the channel:** disconnect the Divoom audio profile, then
  start the daemon again.
- **GIF sends are slow:** reduce `maxFrames`, lower `fps`, or use fewer colors
  via `posterizeBits`.
- **A custom GIF does not show:** verify the path exists. Relative names resolve
  against the bundled Divoom asset directory; absolute paths are used as-is.
- **Only one of several parallel agents appears:** expected behavior. The first
  delegated agent keeps the display until all parallel delegated work finishes.
