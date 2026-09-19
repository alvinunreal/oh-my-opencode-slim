# src/multiplexer/

## Responsibility

Provides a unified abstraction for tmux, Zellij, Herdr, cmux, and kitty to
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
  - `CmuxMultiplexer`: new-generation TUI (`cmux.protocol/2`), noun-first CLI
    (`pane <sel> split/run/close`), two-hop anchor from
    `CMUX_TUI_TERMINAL_ID`, protocol read self-check (never `--version`)
- **Client lifecycle core** (`client/`): see below.
- **Shared Utilities** (`shared.ts`): `quoteShellArg`,
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
- **`tui-wiring.ts` — `createTuiPaneWiring`**: The v1 TUI host wiring. Owns
  admission (`multiplexer.type` × client environment), config reading, plugin
  log initialization, serverUrl reflection (`api.client.client.getConfig()
  .baseUrl` + `/session/status` probe, embedded-sentinel fail-closed), raw
  event projection (`properties.info.directory`, `properties.status.type`),
  the periodic reconcile pass, and best-effort disposal. The v2 `setup()` is
  deliberately not wired.
- **`sweep.ts`**: FR-8 crash-leftover sweep. Closes panes whose encoded owner
  pid is dead **and** whose child session is gone; positive evidence only,
  fail-soft.
- **`pane-title.ts`**: `omosc:<pid>:<childSessionId>` pane-title metadata
  encoding and strict parsing (NFR-5: title content is data, never a command).
- **`diagnostics.ts`**: Structured FR-13 records (`multiplexer.no-pane`,
  `multiplexer.pane-created`) through the plugin file logger, plus the
  once-per-process gate.
- **`ports.ts`**: Injectable IO surface (clock, timers, session status/list
  readers, adapter factory, server URL resolver) used by the core and tests.
- **`types.ts`**: Shared client types and the frozen `NO_PANE_REASONS`
  enumeration.

### Key Interfaces

```typescript
export interface Multiplexer {
  readonly type: 'tmux' | 'zellij' | 'herdr' | 'cmux' | 'kitty';
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

The TUI client subscribes to the host event bus for `session.created`,
`session.status`, `session.idle`, and `session.deleted`:

- **New-pane eligibility**: the event must belong to this client's project
  directory, its `parentID` must equal the displayed session, and admission
  must have passed.
- **Held-pane continuation**: for children this client already tracks,
  status/idle/deleted events keep being processed regardless of the displayed
  session (so panes cannot leak after switching views); rebuilds still require
  the parent to be displayed.
- **Reconcile**: the event bus exposes no reconnect signal, so a bounded
  30 s periodic pass triggers server-list difference compensation and the
  FR-8 sweep.

## Flow

### Pane Creation Flow (client)

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
   ├─ adapter.spawnPane() → split the client's own parent pane
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
   log backfill-skipped
5. FR-8 sweep (startup/reconcile): close encoded leftovers with a dead owner
   and a gone child, best-effort
```

## Integration

### Consumers

- **TUI entry** (`src/tui.ts`): the only production wiring point for the
  client-side pane lifecycle (v1 `tui()`; the v2 `setup()` stays unwired).
- **Adapters**: instantiated by the lifecycle core per operation through
  `factory.ts`; the sweep uses the same instances via its structural
  capability.

The server entry (`src/index.ts`) must not reach `src/multiplexer/client/*` or
`factory.ts`; this boundary is enforced by
`src/dependency-contract.test.ts` (invariant I1).

### Dependencies

- **Config Schema** (`src/config/schema.ts`): `MultiplexerConfig`
  (type/layout/main_pane_size) plus the deprecated-key sanitizer.
- **Logger** (`src/utils/logger.ts`): plugin log sink for all diagnostics.
- **OpenCode host**: TUI event bus (`api.event`), SDK client (`api.client`),
  route (`api.route.current`).

### Configuration

```typescript
interface MultiplexerConfig {
  type: 'tmux' | 'zellij' | 'herdr' | 'cmux' | 'kitty' | 'auto' | 'none';
  layout: 'main-horizontal' | 'main-vertical' | 'tiled' | 'even-horizontal' | 'even-vertical';
  main_pane_size?: number; // Percentage for main pane (20-80), tmux main-* only
}
```

`zellij_pane_mode` is a deprecated key: it is stripped with a
once-per-process warning and never reaches the adapter layer. Invalid
`type`/`layout`/`main_pane_size` values disable pane management with a
once-per-process diagnostic.

### Environment Detection

- **Auto / admission order**: cmux (`CMUX_TUI_SOCKET` or legacy
  `CMUX_MUX_SOCKET`) → tmux (`TMUX_PANE`) → Zellij (`ZELLIJ_PANE_ID`) → Herdr
  (`HERDR_PANE_ID`) → kitty (`KITTY_WINDOW_ID`).
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
- Layout rebalancing is scoped to anchor panes this instance split into and
  debounced (150 ms); close sends Ctrl+C before `kill-pane`.

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

### cmux Implementation

- Detection `CMUX_TUI_SOCKET` (preferred) / legacy `CMUX_MUX_SOCKET`;
  explicit `--socket` / `--session` control plane.
- Anchor two-hop resolution: `CMUX_TUI_TERMINAL_ID` → `terminal <id> show`
  (tab) → `tab <id> show` (pane).
- `pane <sel> split --right/--down`, `pane <sel> run --on-exit keep -- <argv>`,
  `pane <sel> close`; availability by `session current ping` protocol read.
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
| `index.ts` | Public API exports |
| `types.ts` | Core interfaces (`Multiplexer`, `PaneResult`, `PaneSpawnOptions`) |
| `shared.ts` | Shared infrastructure (quoteShellArg, buildOpencodeAttachCommand, buildShellLaunchArgs, findBinary, resolveHostOpencodeBinary, gracefulClosePane) |
| `factory.ts` | Multiplexer instance creation and environment detection |
| `client/index.ts` | Client lifecycle submodule exports |
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
| `kitty/index.ts` | kitty-specific implementation |
| `cmux/index.ts` | cmux new-generation TUI adapter |
