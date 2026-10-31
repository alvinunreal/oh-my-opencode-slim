# src/multiplexer/

## Responsibility

Provides a unified abstraction for tmux, Zellij, Herdr, cmux-tui, kitty, WezTerm, and Orca to
spawn, manage, and close panes for child OpenCode agent sessions — **from the
TUI client process that displays the parent session**, never from the server.

The `client/` submodule owns the per-client pane lifecycle (admission, event
filtering, readiness, stable-idle close, rebuild, reconnect compensation,
crash-leftover sweep, diagnostics); the adapter directories own the
multiplexer-specific command translation.

## Design

### Core Abstractions

- **Multiplexer Interface** (`types.ts`): Defines the contract for terminal
  multiplexer implementations with methods for pane lifecycle management and
  layout application. The optional sweep extension
  (`listPanesWithTitles` / `closePane`) is narrowed structurally by
  `client/sweep.ts`, so the shared interface stays untouched.
- **Concrete Implementations** (all client-local):
  - `TmuxMultiplexer`: tmux CLI commands, `-S <socket>` from `TMUX`,
    pane-level anchoring from `TMUX_PANE`
  - `ZellijMultiplexer`: `new-pane --tab-id <parent tab> --direction <dir>`,
    always same-tab (no dedicated agents tab), `--session` from
    `ZELLIJ_SESSION_NAME`
  - `HerdrMultiplexer`: `pane split --direction`, `pane rename` (label),
    `pane run`, `HERDR_PANE_ID` required (no `--current` fallback)
  - `KittyMultiplexer`: `kitten @` CLI, parent-window anchoring from
    `KITTY_WINDOW_ID`, `--next-to=id:<parent>`, layout via
    `goto-layout --match=window_id:<id>`
  - `WeztermMultiplexer`: `wezterm cli split-pane --pane-id <anchor>` from
    `WEZTERM_PANE`, layout approximated through split order, focus handed
    back with `activate-pane`, `/proc` password bridge, no FR-8 sweep
  - `CmuxMultiplexer`: new-generation TUI (`cmux.protocol/2`), noun-first CLI
    (`pane <sel> run --name <parent/child>`, `tab <sel> focus`,
    `terminal <sel> close`, `terminal list` / `terminal <sel> process show`),
    sibling-tab placement inside the parent pane, two-hop anchor from
    `CMUX_TUI_TERMINAL_ID`, protocol read self-check (never `--version`)
  - `OrcaMultiplexer`: `orca terminal split/close` CLI, anchor handle from
    `ORCA_TERMINAL_HANDLE` + `TERM_PROGRAM=Orca`, layout mapped to split
    direction only (no layout primitives), soft split timeout
- **Client lifecycle core** (`client/`): see below.
- **Shared Utilities** (`shared.ts`): `quoteShellArg`, `PaneShell`,
  `buildOpencodeAttachCommand`, `buildShellLaunchArgs`, `findBinary`,
  `resolveHostOpencodeBinary`, `gracefulClosePane`.
- **Factory** (`factory.ts`): Creates the appropriate multiplexer instance
  based on configuration and environment detection.

### Client Lifecycle Submodule (`client/`)

- **`lifecycle.ts` — `PaneLifecycle`**: Pure lifecycle logic with fully
  injected IO (clock, session status/list readers, adapter factory, server
  URL). Owns the in-process `Map<childSessionId, PaneRecord>` that guarantees
  per-client uniqueness, the stable-idle debounce timers, busy-driven rebuilds
  of idle-closed children, and the reconnect backfill (FR-3/4/6/7/9/10/11).
- **`tui-wiring.ts` — `createTuiPaneWiring`**: The TUI host wiring. The
  caller scopes it to the displayed session's persisted directory (falling
  back to the TUI launch directory), so resumed cross-directory sessions keep
  their child panes. Owns
  admission (`multiplexer.type` × client environment), config reading, plugin
  log initialization, serverUrl reflection (v1: `api.client.client.getConfig()
  .baseUrl` + `/session/status` probe; embedded-sentinel fail-closed), raw
  event projection (v1: `properties.info.directory`,
  `properties.status.type`), the periodic reconcile pass, and best-effort
  disposal. The v2 `setup()` calls it with options from `v2-host.ts` (base
  URL, authenticated `server.info()` probe, status/list readers and projected
  events) that replace the v1 reflection, probe, readers and projection.
- **`sweep.ts`**: FR-8 crash-leftover sweep. Closes views whose encoded owner
  pid is dead **and** whose child session is gone; candidates come from pane
  titles (tmux/zellij/herdr/kitty) or, for cmux-tui, `terminal list` +
  `terminal <sel> process show` argv markers; positive evidence only,
  fail-soft.
- **`pane-title.ts`**: `omosc:<pid>:<childSessionId>` metadata encoding and
  strict parsing (NFR-5: metadata content is data, never a command). cmux-tui
  extracts the `omosc:` token from the `# omosc:...` data marker in the
  spawned process's argv before handing it to the core.
- **`diagnostics.ts`**: Structured FR-13 records (`multiplexer.no-pane`,
  `multiplexer.pane-created`, `multiplexer.pane-closed`) through the plugin file logger, plus the
  once-per-process gate.
- **`ports.ts`**: Injectable IO surface (clock, timers, session status/list
  readers, adapter factory, server URL resolver) used by the core and tests.
- **`types.ts`**: Shared client types and the frozen `NO_PANE_REASONS`
  enumeration.

### Key Interfaces

```typescript
export interface Multiplexer {
  readonly type: 'tmux' | 'zellij' | 'herdr' | 'cmux-tui' | 'kitty' | 'wezterm' | 'orca';
  isAvailable(): Promise<boolean>;
  isInsideSession(): boolean;
  spawnPane(sessionId: string, description: string, serverUrl: string, directory: string, options?: PaneSpawnOptions): Promise<PaneResult>;
  closePane(paneId: string): Promise<boolean>;
  applyLayout(layout: MultiplexerLayout, mainPaneSize: number): Promise<void>;
}
```

### State Management

There is no cross-process or process-global pane state anymore:

- Each client keeps its own pane map **in process memory**, keyed by child
  session id (`PaneLifecycle.panes`); spawns in flight and closed-but-watched
  children are tracked in bounded sets.
- No disk claim, no location registry, no shared registry symbol, no orphan
  cooldowns or close budgets: the pane flow writes zero cross-process files
  (NFR-7).

### Event-Driven Architecture

The TUI client subscribes to the host event bus (v2: the `ctx.data` feed,
projected by `v2-host.ts`) for `session.created`, `session.status`,
`session.idle`, and `session.deleted`:

- **New-pane eligibility**: the event must belong to this client's project
  directory, its `parentID` must equal the displayed session, and admission
  must have passed.
- **Held-pane continuation**: for children this client already tracks,
  status/idle/deleted events keep being processed regardless of the displayed
  session (so panes cannot leak after switching views); rebuilds still require
  the parent to be displayed.
- **Reconcile**: the event bus exposes no reconnect signal, so a bounded
  30 s periodic pass triggers server-list difference compensation (FR-7). The
  FR-8 sweep runs once at startup and on each unreachable → reachable
  transition, not on the periodic tick (candidate discovery costs one
  `process show` read per terminal).

## Flow

### Pane Creation Flow (client)

Shown for v1. On v2, `v2-host.ts` supplies the base URL, an authenticated
`server.info()` probe and `session.list` + `session.active` readers instead.

```
1. Client starts → createTuiPaneWiring():
   ├─ init plugin log (oh-my-opencode-slim.tui-<stamp>.log)
   ├─ load multiplexer config (invalid → type:none + one diagnostic)
   ├─ detect adapter from client env; apply FR-9 admission
   ├─ reflect serverUrl; embedded sentinel / probe failure → host-unreachable
   └─ construct PaneLifecycle + subscribe to the four session events
2. session.created for a child whose parentID is the displayed session:
   ├─ resolve server URL (fail-closed when unreachable)
   ├─ create adapter (unavailable → adapter-unavailable)
   ├─ readiness gate: /session/status?directory=<dir>, bounded retries
   │  └─ timeout → readiness-timeout, no pane
   ├─ adapter.spawnPane() → create the view in the client's own parent pane
   │  (split it, or append a sibling tab inside it for cmux-tui)
   ├─ record in the in-process map + log pane created (identity fields)
   └─ deletion racing the spawn closes the pane right after registration
3. adapter failure → adapter-not-found / adapter-hard / adapter-unavailable
```

### Pane Close and Rebuild Flow (client)

```
1. session.deleted → close immediately
2. session.idle / session.status(idle) → start the stable-idle debounce timer
   ├─ status busy/retry inside the window → cancel the timer, keep the pane
   └─ window elapsed → re-read status; still idle → close
3. Closed-on-idle child turns busy again while its parent is still displayed
   → rebuild through the normal creation path (anchor re-resolved, never
   remembered)
4. Reconnect compensation (30 s reconcile): session.list by parentID is
   authoritative — missing children are backfilled (same eligibility/dedup
   guards), local panes whose child is gone are closed, already-held children
   when quiescent, re-arm a provisional idle deadline
5. FR-8 sweep (startup / unreachable → reachable): close encoded leftovers
   with a dead owner and a gone child, best-effort
```

## Integration

### Consumers

- **TUI entry** (`src/tui.ts`): the only production wiring point for the
  client-side pane lifecycle (v1 `tui()` and the v2 `setup()`).
- **Adapters**: instantiated by the lifecycle core per operation through
  `factory.ts`; the sweep uses the same instances via its structural
  capability.

The server entry (`src/index.ts`) must not reach `src/multiplexer/client/*` or
`factory.ts`; this boundary is enforced by
`src/dependency-contract.test.ts` (invariant I1).

### Dependencies

- **Config Schema** (`src/config/schema.ts`): `MultiplexerConfig`
  (type/layout/main_pane_size/cmux_tui_binary/viewer); removed keys are
  rejected by the schema.
- **Logger** (`src/utils/logger.ts`): plugin log sink for all diagnostics.
- **OpenCode host**: TUI event bus (`api.event`), SDK client (`api.client`),
  route (`api.route.current`); on v2 the `ctx.data` feed, `ctx.client`,
  `ctx.ui.router.current()` and `ctx.location`, through `v2-host.ts`.

### Configuration

```typescript
interface MultiplexerConfig {
  type: 'tmux' | 'zellij' | 'herdr' | 'cmux-tui' | 'kitty' | 'wezterm' | 'orca' | 'auto' | 'none';
  layout: 'main-horizontal' | 'main-vertical' | 'tiled' | 'even-horizontal' | 'even-vertical';
  main_pane_size?: number; // Percentage for main pane (20-80), tmux main-* and the first WezTerm main-* split
  cmux_tui_binary?: string; // Explicit cmux-tui binary path
  viewer?: 'tui' | 'mini'; // Host default: v1 'tui', v2 'mini'; explicit wins
}
```

`zellij_pane_mode` is removed; the loader strips it with a warning. Invalid
`type`/`layout`/`main_pane_size`/`cmux_tui_binary`/`viewer` values disable
pane management with a once-per-process diagnostic.

The host wiring resolves an omitted viewer. v1 mini uses `attach ... --dir
<dir> --mini` (OpenCode >= 1.17.10), without extra pane-cwd pinning; v2 mini
uses the `mini` subcommand without a positional directory, so adapters pin
the cwd. Herdr, kitty, and WezTerm always set their native cwd flags; Orca
has no cwd flag (the split inherits the anchor's working directory).

### Environment Detection

- **Auto / admission order**: cmux-tui (`CMUX_TUI_SOCKET` or legacy
  `CMUX_MUX_SOCKET`) → tmux (`TMUX_PANE`) → Zellij (`ZELLIJ_PANE_ID`) → Herdr
  (`HERDR_PANE_ID`) → kitty (`KITTY_WINDOW_ID`) → WezTerm (`WEZTERM_PANE`,
  so tmux/Zellij nested inside WezTerm win) → Orca (`ORCA_TERMINAL_HANDLE`,
  last).
- **Explicit adapter**: only enabled when it matches the detected adapter;
  otherwise `admission-mismatch` and no pane.
- **Availability checks**: binary probes, Zellij >= 0.44.1 version gate, and
  the cmux protocol read self-check.

## Implementation Details

### Tmux Implementation

- Detection `TMUX_PANE`; every command carries `-S <socket>` from the first
  segment of `TMUX`.
- Split direction follows the layout (`-h` for main-vertical/even-horizontal/
  tiled, `-v` for main-horizontal/even-vertical), then `select-layout` plus
  `main-pane-width`/`main-pane-height` for `main-*`.
- Split and layout run in one invocation. Main layouts split before the pane
  following the anchor when available; close sends Ctrl+C before a combined
  `kill-pane` and layout command for panes this instance created.

### Zellij Implementation

- Detection `ZELLIJ_PANE_ID`; every invocation is prefixed with
  `--session <ZELLIJ_SESSION_NAME>`.
- Single placement behavior: `new-pane --tab-id <parent tab> [--direction
  <dir>]`, same tab as the parent; a silently dropped directed split is
  retried once without the direction.
- Version gate >= 0.44.1 (`new-pane --tab-id` and the stable `tab_id` field of
  `list-panes --json --tab --all`).

### Herdr Implementation

- Detection `HERDR_PANE_ID` (required; no `--current` fallback).
- `pane split --direction`, `pane rename` (label) for FR-8 metadata,
  `pane run` for the attach command; spawns are serialized to protect the
  `main-vertical` agent-area tracking.
- `main-vertical` approximates a main/agent column: the first right-side pane
  becomes the agent area, later children stack down inside it.

### Kitty Implementation

- Detection `KITTY_WINDOW_ID`; requires `KITTY_LISTEN_ON` (from
  `listen_on` in `kitty.conf`), passed through to every `kitten @` call.
- The parent window's tab is the anchor: `--next-to=id:<parent>` for
  placement, `goto-layout --match=window_id:<parent>` for the mapped layout;
  the active tab is never modified.

### WezTerm Implementation

- Detection `WEZTERM_PANE`; the CLI reaches WezTerm through the
  `WEZTERM_UNIX_SOCKET` it exports to every pane, so no configuration is
  needed. The binary is the `wezterm` next to `WEZTERM_EXECUTABLE` (falling
  back to `PATH`), and every call passes `cli --no-auto-start`.
- Every split names its target with `--pane-id`. `split-pane` focuses the new
  pane, so the pane focused before the split (`list-clients`) is activated
  again, falling back to the anchor.
- No preset layouts: `main-*` split the anchor once at `100 -
  main_pane_size` percent, then stack later children inside that agent pane
  (like Herdr); `even-*`/`tiled` always split the anchor. Spawns are
  serialized. Stacking falls back to the anchor only on `pane_id N invalid`;
  other failures are hard errors (no second split). No rebalancing.
- Viewer password: `split-pane` has no env flag and panes inherit WezTerm's
  environment, so the launch script uses the `/proc` bridge, exporting
  `OPENCODE_PASSWORD` (v2 remote) or only `OPENCODE_SERVER_PASSWORD` plus any
  `OPENCODE_SERVER_USERNAME` (v1). Linux and a POSIX shell are required;
  otherwise no pane, with a once-per-process `viewer-secret` diagnostic.
- Close: Ctrl+C via `send-text`, then `kill-pane`. A failed `kill-pane` counts
  as closed only on WezTerm's `no such pane N` error (`isAlreadyClosed`); any
  other failure keeps the pane tracked, because the CLI also exits 1 on
  transport/protocol errors while the pane still exists.
- No FR-8 sweep: the CLI cannot set pane titles and the viewer replaces them.

### Orca Implementation

- Detection `ORCA_TERMINAL_HANDLE` + `TERM_PROGRAM=Orca`; binary from
  `$ORCA_CLI_BIN_DIR/orca` or `PATH`, availability probed with
  `orca status --json` (`ok` + `app.running`).
- `orca terminal split --terminal <anchor> --direction <dir>` (no `--cwd`;
  the split inherits the anchor's cwd); handle read from
  `result.split.handle`. A split timeout is a soft `unavailable` failure
  (never `hard`, never pane loss); a missing anchor is `not_found`.
- Layout maps to split direction only (`main-vertical`/`even-horizontal`/
  `tiled` → horizontal, `main-horizontal`/`even-vertical` → vertical);
  `applyLayout` is a no-op (Orca has no layout primitives).
- Close: `orca terminal close --terminal <handle>`, exit 0 only. No FR-8
  sweep (titles are shell-overwritten, like WezTerm). win32: `spawnPane`
  refuses with `unavailable`.

### cmux-tui Implementation

- Detection `CMUX_TUI_SOCKET` (preferred) / legacy `CMUX_MUX_SOCKET`;
  explicit `--socket` / `--session` control plane.
- Anchor two-hop resolution: `CMUX_TUI_TERMINAL_ID` → `terminal <id> show`
  (tab) → `tab <id> show` (pane).
- Placement is a **sibling tab appended inside the parent pane**:
  `pane <sel> run --on-exit keep --name <parent_name/child_name> -- <argv>`
  (created already named; appended at the end, never reordered), followed by
  `tab <pre-spawn active tab> focus` to restore the user's view (falling back
  to the parent tab when it cannot be determined). No screen-level split.
- Display name is human-readable `parent_name/child_name`: `parent_name` is the
  parent tab's `name`, else `Agent<plugin pid>`; `child_name` is
  `<subagent_type>:<up to 5-char child session id suffix>`. The name never
  carries the `omosc:` sweep metadata (that lives in the spawn argv marker).
- Close uses `terminal <sel> close` (removes every view and ends the process);
  the handle is the terminal id. FR-8 candidates are discovered from
  `terminal list` and confirmed by `terminal <sel> process show` argv markers;
  availability by `session current ping` protocol read.
- Layout is ignored: `multiplexer.layout` / `multiplexer.main_pane_size`
  produce no commands.
- Deliberately absent: `equalize`, readiness polling, mutation queues, orphan
  cooldowns, close budgets, deferred spawns, hot-reload takeover, and global
  pane registries.

### Error Handling

- Fail-closed everywhere: unresolvable anchor → no multiplexer command is
  issued; embedded host → no pane; readiness timeout → no pane.
- Every "no pane" outcome is logged with a distinguishable reason from
  `NO_PANE_REASONS`; failures never abort the remaining lifecycle work.
- Graceful degradation: an unavailable adapter is skipped rather than failing
  the plugin.

## Testing

- Client core tests (`client/*.test.ts`): lifecycle (eligibility, dedup,
  stable idle, rebuild, backfill), wiring (admission, host probe, event
  projection, dispose), sweep, pane titles, diagnostics.
- Adapter tests (`*/index.test.ts`): command-level assertions for placement,
  layout mapping, explicit addressing, fail-closed anchors, and close.
- Boundary test (`src/dependency-contract.test.ts`): the server entry's
  dependency graph cannot reach pane modules.
- `src/tui.test.ts` covers the TUI-side wiring/disposal path.

## Files

| File | Purpose |
|------|---------|
| `types.ts` | Core interfaces (`Multiplexer`, `PaneResult`, `PaneSpawnOptions`) |
| `shared.ts` | Shared infrastructure (quoteShellArg, PaneShell, buildOpencodeAttachCommand, buildShellLaunchArgs, findBinary, resolveHostOpencodeBinary, gracefulClosePane) |
| `factory.ts` | Multiplexer instance creation and environment detection |
| `client/lifecycle.ts` | Per-client pane lifecycle core (FR-3/4/6/7/10/11) |
| `client/tui-wiring.ts` | TUI host wiring: admission, config, logs, serverUrl, events, reconcile |
| `client/sweep.ts` | FR-8 crash-leftover pane sweep |
| `client/pane-title.ts` | Pane-title metadata encoding/parsing |
| `client/diagnostics.ts` | Structured no-pane / pane-created diagnostics |
| `client/ports.ts` | Injectable IO surface for the lifecycle core |
| `client/types.ts` | Client types and the `NO_PANE_REASONS` enumeration |
| `tmux/index.ts` | tmux-specific implementation |
| `zellij/index.ts` | zellij-specific implementation |
| `herdr/index.ts` | herdr-specific implementation |
| `herdr/layout-equalize.ts` | Herdr socket-backed agent-pane equalization |
| `kitty/index.ts` | kitty-specific implementation |
| `wezterm/index.ts` | WezTerm-specific implementation |
| `cmux/index.ts` | cmux-tui new-generation TUI adapter |
| `orca/index.ts` | Orca-specific implementation |
