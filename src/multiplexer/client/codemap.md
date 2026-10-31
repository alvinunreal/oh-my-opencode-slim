# src/multiplexer/client/

## Responsibility

Implements the per-client pane lifecycle core that moved from server-side session-manager into the TUI client process. This extracted module owns:

- **Per-client pane map**: In-memory `Map<childSessionId, PaneRecord>` ensuring uniqueness per client
- **Admission control**: FR-9 client environment filtering for multiplexer adapter selection
- **Event-driven coordination**: Four-session event subscription (`created`, `status`, `idle`, `deleted`)
- **Readiness gating**: Bounded readiness probe (FR-4) before spawning panes
- **Stable idle management**: FR-10 stable-idle debounce timers and FR-11 busy-driven rebuilds
- **Reconnect backfill**: FR-7 reconciliation with server session list
- **Crash-leftover sweep**: FR-8 cleanup of panes with dead owners
- **Diagnostics and logging**: FR-13 structured diagnostic records via plugin file logger

All operations run exclusively in the TUI client process that displays the parent session, never from the server (invariant I1, task 3.10).

## Design

### Core Components

#### `lifecycle.ts` - `PaneLifecycle`
Pure lifecycle logic with fully injected IO:
- **ClientPorts**: Dependency injection for clock, session status/list readers, adapter factory, server URL
- **In-process pane map**: `Map<childSessionId, PaneRecord>` guaranteeing per-client uniqueness (FR-6)
- **Debounce timers**: Stable-idle tracking (FR-10) and busy-driven rebuilds (FR-11)
- **Reconnect logic**: FR-7 reconciliation that backfills missing children from server session list

#### `tui-wiring.ts` - `createTuiPaneWiring`
TUI host wiring (v1 `tui()` and v2 `setup()`) that:
- **Initializes plugin log**: `oh-my-opencode-slim.tui-<timestamp>.log`
- **Loads multiplexer config**: Accepts the TUI's pre-read admission snapshot; invalid config → `type:none` + diagnostic. v2 reuses the URL resolution's authenticated `server.info()` result for its first probe; later probes read fresh.
- **Detects adapter**: From client environment; applies FR-9 admission control
- **Reflects serverUrl**: v1 default via `api.client.client.getConfig().baseUrl` + `/session/status` probe, authenticated for password-protected hosts with the client's own `Authorization` header (set by `opencode attach` from `-p`/`-u` or the environment), else `OPENCODE_SERVER_PASSWORD` from the client env; v2 passes `baseUrl` and an authenticated `server.info()` probe from `v2-host.ts`
- **Embeds sentinel**: Fail-closed when host unreachable
- **Projects raw events**: v1 envelope (`properties.info.directory`, `properties.status.type`); v2 passes already-projected `sessionEvents`
- **Runs periodic reconcile**: 30-second pass for reconnect compensation
- **Provides disposal**: Best-effort cleanup

#### `sweep.ts` - Crash Leftover Cleanup
- **FR-8 sweep**: Closes panes whose encoded owner pid is dead **and** child session is gone
- **Positive evidence only**: Fail-soft, no false positives
- **Called from**: Startup and reconcile passes

#### `pane-title.ts` - Metadata Encoding
- **Encoding**: `omosc:<pid>:<childSessionId>` pane-title metadata
- **Strict parsing**: NFR-5: title content is data, never a command

#### `diagnostics.ts` - Structured Logging
- **FR-13 records**: `multiplexer.no-pane`, `multiplexer.pane-created`
- **Plugin file logger**: All diagnostics through centralized sink
- **Once-per-process gate**: Prevents duplicate logging

#### `ports.ts` - Injectable IO
- **Clock/timers**: For debounce operations
- **Session readers**: Status and list read interfaces
- **Adapter factory**: Creates multiplexer instances per operation
- **Server URL resolver**: Provides server base URL

#### `types.ts` - Shared Types
- **Client types**: `AdapterType`, `NoPaneReason`, `PaneRecord`, `SessionLifecycleEvent`, `SessionRuntimeStatus`
- **Frozen enumeration**: `NO_PANE_REASONS` for diagnostic consistency

### Key Interfaces

```typescript
export interface ClientPorts {
  readonly clock: Clock;
  readonly statusReader: SessionStatusReader;
  readonly sessionListReader: SessionListReader;
  readonly adapterFactory: AdapterFactory;      // sync .create(): Multiplexer | null
  readonly resolveServerUrl: ServerUrlResolver; // -> ServerUrlResolution { url?, unreachable? }
  readonly resolveAnchoredTarget?: () => string | null;          // FR-13 anchor; 'unknown' fallback
  readonly resolvePaneTitle?: (childSessionId: string) => string; // FR-8 title; defaults to session id
  readonly onChildTracked?: (childSessionId: string, directory: string) => void; // backfill dir mapping
}

export interface PaneLifecycleConfig {
  directory: string;              // project directory (FR-3)
  displayedSessionId: string | null;
  adapter: AdapterType | null;    // null when admission failed (FR-9)
  layout: MultiplexerLayout;
  mainPaneSize: number;
  stableIdleMs: number;           // FR-10 debounce window
  readiness: ReadinessPolicy;
  viewer?: Pick<PaneSpawnOptions, 'viewerFlavor' | 'viewerPassword' | 'viewerSurface'>;
}
```

## Flow

### Pane Creation Flow

Shown for v1. On v2, `v2-host.ts` supplies the base URL, an authenticated
`server.info()` probe and `session.list` + `session.active` readers instead.

```
1. Client startup → createTuiPaneWiring():
   ├─ Init plugin log (oh-my-opencode-slim.tui-<timestamp>.log)
   ├─ Load multiplexer config (invalid → type:none + diagnostic)
   ├─ Detect adapter from client env; apply FR-9 admission
   ├─ Reflect serverUrl; embedded sentinel / probe failure → host-unreachable
   └─ Construct PaneLifecycle + subscribe to four session events

2. session.created for child whose parentID is displayed session:
   ├─ Resolve server URL (fail-closed when unreachable)
   ├─ Create adapter (unavailable → adapter-unavailable)
   ├─ Readiness gate: /session/status?directory=<dir>, bounded retries
   │  └─ Timeout → readiness-timeout, no pane
   ├─ Adapter.spawnPane() → split client's own parent pane
   ├─ Record in in-process map + log pane created (identity fields)
   └─ Deletion racing spawn closes pane right after registration

3. Adapter failure → adapter-not-found / adapter-hard / adapter-unavailable
```

### Pane Close and Rebuild Flow

```
1. session.deleted → close immediately

2. session.idle / session.status(idle) → start stable-idle debounce timer
   ├─ Status busy/retry inside window → cancel timer, keep pane
   └─ Window elapsed → re-read status; still idle → close

3. Closed-on-idle child turns busy again while parent still displayed
   → Rebuild through normal creation path (anchor re-resolved, never remembered)

4. Reconnect compensation (30s reconcile):
   ├─ Server list by parentID is authoritative
   ├─ Missing children backfilled (same eligibility/dedup guards)
   ├─ Local panes whose child is gone are closed
   └─ Already-held children log backfill-skipped; quiescent ones re-arm a
      provisional idle deadline (the first real idle edge restarts it)

5. FR-8 sweep (startup/reconcile):
   ├─ Close encoded leftovers with dead owner and gone child
   └─ Best-effort cleanup
```

## Integration

### Consumers

- **TUI entry** (`src/tui.ts`): Only production wiring point for client-side pane lifecycle (v1 `tui()` and v2 `setup()`)
- **Adapters**: Instantiated by lifecycle core per operation through `factory.ts`
- **Server boundary**: `src/index.ts` must not import `src/multiplexer/client/*` or `factory.ts` (invariant I1)

### Dependencies

- **Config Schema** (`src/config/schema.ts`): `MultiplexerConfig` definition
- **Logger** (`src/utils/logger.ts`): Plugin log sink for all diagnostics
- **OpenCode host**: TUI event bus (`api.event`), SDK client (`api.client`), route (`api.route.current`); on v2 the `ctx.data` feed, `ctx.client`, `ctx.ui.router.current()` and `ctx.location`, through `v2-host.ts`

## Testing

- **Client core tests** (direct children: `lifecycle.test.ts`, `tui-wiring.test.ts`, `sweep.test.ts`, `pane-title.test.ts`, `diagnostics.test.ts`):
  - Lifecycle (eligibility, dedup, stable idle, rebuild, backfill)
  - Wiring (admission, host probe, event projection, dispose)
  - Sweep, pane titles, diagnostics
- **Adapter tests** (`*/index.test.ts`): Command-level assertions for placement, layout mapping, fail-closed anchors, and close
- **Boundary test** (`src/dependency-contract.test.ts`): Server entry's dependency graph cannot reach pane modules
- **TUI test** (`src/tui.test.ts`): TUI-side wiring/disposal path

## Files

| File | Purpose |
|------|---------|
| `lifecycle.ts` | Per-client pane lifecycle core (FR-3/4/6/7/10/11) |
| `tui-wiring.ts` | TUI host wiring: admission, config, logs, serverUrl, events, reconcile |
| `sweep.ts` | FR-8 crash-leftover pane sweep |
| `pane-title.ts` | Pane-title metadata encoding/parsing |
| `diagnostics.ts` | Structured no-pane / pane-created diagnostics |
| `ports.ts` | Injectable IO surface for the lifecycle core |
| `types.ts` | Client types and the `NO_PANE_REASONS` enumeration |

## Architectural Impact

This extraction moved pane lifecycle management from server-side `session-manager.ts` into the client process, achieving:

- **Per-client isolation**: Each client maintains its own pane map in memory
- **Zero cross-process state**: No disk claims, location registries, or shared symbols
- **Fail-closed safety**: Unresolvable operations result in no panes (FR-5)
- **Graceful degradation**: Unavailable adapters skip rather than fail the plugin
- **Compliance**: All FRs and NFRs (FR-1 through FR-13, NFR-5, NFR-7) enforced

The client now owns the entire pane flow from admission through cleanup, enabling true per-client multiplexer operations.
