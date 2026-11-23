# src/multiplexer/rex/

## Responsibility

Client-only Superlogical Rex adapter for viewing existing child sessions.
The shared `client/` lifecycle owns admission, readiness, stable-idle close,
busy rebuilds and reconciliation; Rex adds no parallel lifecycle.

## Design

- `RexMultiplexer` in `index.ts` implements `Multiplexer`.
- Both trimmed `REX_SESSION` and `REX_BLOCK` are required. Auto detection
  follows cmux-tui/tmux/Zellij/Herdr and precedes kitty/WezTerm/Orca.
- Split explicitly targets that session and parent block, with
  `--focus=false`, `--cwd`, `--label`, `--json`, `--split` and `--ratio`.
  `--shell=none --` launches the shared shell argv without Rex adding another
  shell. CLI calls use `--autostart=false --timeout 5s`.
- Layout maps to `right` for `main-vertical`/`even-horizontal`/`tiled`,
  `below` for `main-horizontal`/`even-vertical`. `--ratio` is the **new
  pane's percentage**: `100 - main_pane_size` for `main-*`, otherwise `50`.
  Every child splits the original parent: no dedicated agent area,
  equalization or layout rebalancing.
- Shared viewer command helpers handle TUI/mini and host version/service
  differences. The split supplies the working directory natively.
- Windows is unsupported. No supported environment-injection transport:
  v2-remote `viewerPassword !== undefined` or v1
  `OPENCODE_SERVER_PASSWORD !== undefined` refuses before mutation, including
  empty values. Credentials never enter viewer command text or labels.
- Only a new non-anchor block ID from `block_ids` may become a pane handle;
  a reported anchor must match. Splits are never retried after a failure.
  The in-memory `ownedBlocks` map scopes `rex block close --session <session>
  <block>` to this instance's returned blocks and their original sessions.
  Only exit 0 removes the handle; a failed close keeps it tracked.
- No FR-8 crash-leftover sweep; labels alone do not enable recovery.

## Integration

- `../factory.ts`: explicit `rex` and environment-based `auto` selection.
- `../client/tui-wiring.ts`: matching client admission and anchor resolution.
- `../../config/schema.ts`: `rex` type; no Rex-specific configuration keys.
- [User guide](../../../docs/multiplexer-integration.md#rex).
