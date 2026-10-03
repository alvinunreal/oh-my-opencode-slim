# companion/

## Responsibility

Desktop companion application showing active agent GIFs per session. Runs as an accessory macOS app (invisible Dock), displays floating animated windows over projects, and visualizes agent activity through embedded sprite sheets.

## Design

The companion communicates with OpenCode host runtime via file-based state sharing (JSON files) and displays animated overlays for active agents:

- Displays animated GIFs for `idle`, `question`, `unknown`, and agent-specific animations (`council`, `designer`, `explorer`, `fixer`, `librarian`, `observer`, `oracle`, `orchestrator`).
- Animated windows can be resized (S/M/L/XL presets), repositioned via drag-and-drop, and anchored to screen edges.
- The right-click menu exposes explicit Project/Global OMO preset scopes. Project scope is the default and can create/remove a local override via Inherit; Global scope changes only the user layer. The native UI writes typed scoped requests into shared state while TypeScript remains the sole owner of config validation and persistence.
- Session state tracks window positions, sizes, and config per project directory using a hidden state file.
- Animations are pre-generated as 72-frame JPEG sprite sheets (12x6 grid, 200x200 each frame) from companion/VIDEOS/*.mp4 source videos.

## Flow

1. Companion reads OH_MY_OPENCODE_SLIM_COMPANION_SESSION_ID environment variable to identify its owner session.
2. Acquires a singleton lock via file-based coordination to prevent duplicate instances.
3. Loads agent sprite sheets embedded at compile time from `companion/animations/` (`include_bytes!` in `gifs.rs`); `state.rs` is the Rust state module, not a data file.
4. Renders animated overlays in an Egui window for each active session using that in-process state.
5. Persistent state stores window geometry, size, config per project directory in `$XDG_DATA_HOME/opencode/storage/oh-my-opencode-slim/companion-state.json` (XDG fallback: `~/.local/share`).

## Integration

- Acts as a UI visualization layer for OpenCode sessions, complementing the TS plugin.
- Injected into OpenCode runtime via OH_MY_OPENCODE_SLIM_COMPANION_SESSION_ID environment variable.
- `companion/VIDEOS/` holds MP4 source media used to generate the runtime JPEG sprite sheets; release binaries embed the sheets from `companion/animations/` via `include_bytes!` and never decode the MP4s.
- Serves as the visual anchor for agent activity indicators in the oh-my-opencode-slim ecosystem.
