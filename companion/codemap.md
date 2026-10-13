# companion/

## Responsibility

Desktop companion application showing active agent GIFs per session. Runs as an accessory macOS app (invisible Dock), displays floating animated windows over projects, and visualizes agent activity through embedded sprite sheets.

## Design

The companion communicates with OpenCode host runtime via file-based state sharing (JSON files) and displays animated overlays for active agents:

- Displays animated GIFs for `idle`, `question`, `unknown`, and agent-specific animations (`council`, `designer`, `explorer`, `fixer`, `librarian`, `observer`, `oracle`, `orchestrator`).
- Agent tiles can expose live session model/variant metadata on hover; waiting-input uses an attention outline without changing the animation contract. Error attention is intentionally deferred until canonical terminal evidence is available.
- Each waiting-input request carries a monotonic attention generation; native informational attention deduplicates by session/generation so back-to-back questions cannot collapse into one notification. The plugin restores that generation/request fence across manager replacement; ordinary states reset the native request.
- Animated windows can be resized (S/M/L/XL presets), repositioned via drag-and-drop, and anchored to screen edges. Window-position persistence is dispatched off the egui thread with latest-write-wins generation fencing so shared-state lock contention cannot freeze animation or dragging.
- The right-click menu pins the currently displayed project while open and adds project navigation across every live repository, so preset changes never depend on waiting for the desired repo to become active. The selected project becomes both the displayed session and preset target until the menu closes; closed-menu display still follows live activity. Project/Global preset scope remains explicit (`Prj:` / `Gbl:`), Project supports Inherit, and missing preset state is shown as a disabled diagnostic instead of hiding controls. The native UI writes typed scoped requests into shared state while TypeScript remains the sole owner of config validation and persistence. Pending UI state tracks the target session and clears on completion or target disappearance. Applied request IDs fence side effects from stale queue entries when acknowledgement persistence fails.
- Project actions stay native and host-independent: open the published session cwd in the platform file manager or copy it through egui clipboard output. The opener is reaped off the UI thread; status is session-scoped, async completion never closes a later menu, and failures reuse the compact Open button instead of increasing menu height.
- Session state tracks window positions, sizes, and config per project directory using a hidden state file.
- Animations are pre-generated as 72-frame JPEG sprite sheets (12x6 grid, 200x200 each frame) from companion/VIDEOS/*.mp4 source videos.

## Flow

1. Companion reads OH_MY_OPENCODE_SLIM_COMPANION_SESSION_ID as the process that launched the singleton; display selection itself is activity-driven and may target any published live project.
2. Acquires a singleton lock via file-based coordination to prevent duplicate instances.
3. Loads agent sprite sheets embedded at compile time from `companion/animations/` (`include_bytes!` in `gifs.rs`); `state.rs` is the Rust state module, not a data file.
4. Renders animated overlays in an Egui window for each active session using that in-process state.
5. Persistent state stores window geometry, size, config per project directory in `$XDG_DATA_HOME/opencode/storage/oh-my-opencode-slim/companion-state.json` (XDG fallback: `~/.local/share`).

## Integration

- Acts as a UI visualization layer for OpenCode sessions, complementing the TS plugin.
- Injected into OpenCode runtime via OH_MY_OPENCODE_SLIM_COMPANION_SESSION_ID environment variable.
- `companion/VIDEOS/` holds MP4 source media used to generate the runtime JPEG sprite sheets; release binaries embed the sheets from `companion/animations/` via `include_bytes!` and never decode the MP4s.
- Serves as the visual anchor for agent activity indicators in the oh-my-opencode-slim ecosystem.

## Shared-state locking

`state.rs` recovers abandoned `companion-state.json.lock` directories after a bounded stale interval. Native window-position writes run on a background worker, while the UI keeps the latest position in memory until the shared state reflects it. This prevents the previous one-second UI stall when a state writer was blocked.
