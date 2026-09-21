/**
 * TUI host wiring for the client-side pane lifecycle (task 3.6).
 *
 * The v1 TUI entry (`src/tui.ts`'s `tui()`) calls `createTuiPaneWiring`; the
 * v2 `setup()` is deliberately not wired (NFR-6). This module owns the
 * client-local concerns the frozen lifecycle core cannot know about:
 *
 * - admission: project config `multiplexer.type` x this client's own
 *   environment (FR-9), with exactly one process-wide diagnostic per cause;
 * - config reading (FR-12) and plugin log initialization (FR-13);
 * - serverUrl reflection via `api.client.client.getConfig().baseUrl` plus a
 *   `/session/status` reachability probe; missing/sentinel values and probe
 *   failures are fail-closed (D3, embedded mode);
 * - projection of raw TUI session events onto `SessionLifecycleEvent`: the
 *   raw envelope has no top-level `directory` (it lives at
 *   `properties.info.directory`) and `session.status` carries its status at
 *   `properties.status.type` (stage A evidence 1.1);
 * - disposal: unsubscribe, stop timers, best-effort close of owned panes.
 *
 * The module imports no TUI rendering code so its unit tests run without a
 * renderer. Adapters and the lifecycle core are injected (NFR-3).
 */

import { loadPluginConfig } from '../../config/loader';
import {
  type MultiplexerConfig,
  MultiplexerConfigSchema,
  type MultiplexerType,
} from '../../config/schema';
import { isRecord } from '../../utils/guards';
import { initLogger } from '../../utils/logger';
import { getMultiplexer } from '../factory';
import type { Multiplexer } from '../types';
import {
  createOnceGate,
  DIAGNOSTIC_EVENT_NO_PANE,
  type DiagnosticLogger,
  logNoPane,
  type OnceGate,
  PLUGIN_LOG_SINK,
} from './diagnostics';
import { PaneLifecycle, type ReadinessPolicy } from './lifecycle';
import { encodePaneTitle } from './pane-title';
import type {
  AdapterFactory,
  ClientPorts,
  Clock,
  ClockTimerHandle,
  SessionListReader,
  SessionStatusRead,
  SessionStatusReader,
} from './ports';
import {
  asSweepAdapter,
  defaultIsProcessAlive,
  type SweepAdapter,
  sweepLeftoverPanes,
} from './sweep';
import type {
  AdapterType,
  NoPaneReason,
  SessionLifecycleEvent,
  SessionRuntimeStatus,
} from './types';

/** Base URL the embedded (listener-less) host reflects (stage A evidence 1.2). */
export const EMBEDDED_HOST_BASE_URL = 'http://opencode.internal';

/**
 * Stable-idle debounce window (FR-10). OQ-1 fixes the final value after the
 * scenario 6 measurement; 5s keeps the 1-2s "brief idle" case alive.
 */
export const DEFAULT_STABLE_IDLE_MS = 5_000;

/** Bounded readiness probe: ~2s total, inside the NFR-1 latency budget. */
export const DEFAULT_READINESS: ReadinessPolicy = {
  maxAttempts: 10,
  retryDelayMs: 200,
};

export const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
export const DEFAULT_STATUS_TIMEOUT_MS = 1_500;
export const DEFAULT_LIST_TIMEOUT_MS = 5_000;

/** Minimum gap between recovery probes once the host looked unreachable. */
export const HOST_REPROBE_INTERVAL_MS = 5_000;

/**
 * Low-frequency reconcile cadence (FR-7). The TUI event bus exposes no
 * reconnect signal (stage A 1.5), so a bounded periodic pass is the trigger
 * for the server-list difference compensation and the FR-8 leftover sweep.
 */
export const RECONCILE_INTERVAL_MS = 30_000;

/** Raw session events the client consumes (FR-3). */
export const SESSION_EVENT_TYPES = [
  'session.created',
  'session.status',
  'session.idle',
  'session.deleted',
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/** Minimal host event bus surface (`api.event`). */
export interface ClientEventBus {
  on(type: string, handler: (event: unknown) => void): () => void;
}

/** Result of reading the project config for pane admission. */
export interface LoadedPaneConfig {
  multiplexer: MultiplexerConfig;
  /** True for loader-level failures (invalid JSON/schema/read error). */
  invalid: boolean;
}

/** Client-local admission outcome (FR-9). */
export interface AdmissionDecision {
  enabled: boolean;
  /** Admitted adapter; null when disabled. */
  adapter: AdapterType | null;
  /** Why admission failed; null when enabled. */
  reason: NoPaneReason | null;
  /** True when an invalid config forced the feature off. */
  configInvalid: boolean;
}

/** Injected fetch surface for the reachability probe. */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok?: boolean }>;

export interface TuiPaneWiringOptions {
  /** Project directory this client serves. */
  directory: string;
  /** Session currently displayed; read per event because routes change. */
  getDisplayedSessionId?: () => string | null | undefined;
  /** Host event bus (`api.event`); absent hosts subscribe to nothing. */
  eventBus?: ClientEventBus | null;
  /** Host SDK client (`api.client`) used for reflection and reads. */
  client?: unknown;
  /** Environment of this client process; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Config loader seam; defaults to `loadPluginConfig`. */
  loadConfig?: (directory: string) => LoadedPaneConfig;
  /** Adapter factory seam; defaults to `getMultiplexer`. */
  adapterFactory?: AdapterFactory;
  /** Diagnostic sink; defaults to the plugin file logger. */
  logger?: DiagnosticLogger;
  /** Once-per-process gate; defaults to a module-level gate. */
  onceGate?: OnceGate;
  /** fetch seam for the reachability probe. */
  fetchFn?: FetchLike;
  /** Clock for the lifecycle core; defaults to real timers. */
  clock?: Clock;
  stableIdleMs?: number;
  readiness?: ReadinessPolicy;
  /** Plugin log initializer seam; defaults to `initLogger`. */
  initLogging?: () => void;
  probeTimeoutMs?: number;
  statusTimeoutMs?: number;
  listTimeoutMs?: number;
  /** Owner pid encoded into pane titles (FR-8); defaults to `process.pid`. */
  ownerPid?: number;
  /** Reconcile cadence (FR-7); defaults to `RECONCILE_INTERVAL_MS`. */
  reconcileIntervalMs?: number;
  /** Sweep capability seam; defaults to narrowing the admitted adapter. */
  sweepAdapter?: SweepAdapter | null;
  /** Liveness probe seam for the FR-8 sweep. */
  isProcessAlive?: (pid: number) => boolean;
  /** Terminal-session probe seam for the FR-8 sweep. */
  isSessionTerminal?: (childSessionId: string) => Promise<boolean>;
}

export interface TuiPaneWiring {
  readonly admission: AdmissionDecision;
  readonly detectedAdapter: AdapterType | null;
  /** Core instance; null when admission or host reachability disabled panes. */
  readonly lifecycle: PaneLifecycle | null;
  /** Current host reachability as seen by `resolveServerUrl`. */
  isHostReachable(): boolean;
  /** Unsubscribes, stops timers and best-effort closes owned panes. */
  dispose(): Promise<void>;
}

/** Process-wide gate for once-per-process diagnostics (FR-9/FR-13). */
const processOnceGate = createOnceGate();

/** Detects the multiplexer this client runs inside (FR-9, adapter matrix). */
export function detectClientAdapter(
  env: Record<string, string | undefined> = process.env,
): AdapterType | null {
  if (env.CMUX_TUI_SOCKET || env.CMUX_MUX_SOCKET) return 'cmux';
  if (env.TMUX_PANE) return 'tmux';
  if (env.ZELLIJ_PANE_ID) return 'zellij';
  if (env.HERDR_PANE_ID) return 'herdr';
  if (env.KITTY_WINDOW_ID) return 'kitty';
  return null;
}

/** The explicit adapter named by config, if the config names one. */
function explicitAdapterOf(type: MultiplexerType): AdapterType | undefined {
  return type === 'auto' || type === 'none' ? undefined : type;
}

/** Applies the FR-9 admission table: `none` / `auto` / explicit adapter. */
export function decideAdmission(
  type: MultiplexerType,
  detected: AdapterType | null,
  configInvalid = false,
): AdmissionDecision {
  if (configInvalid) {
    return {
      enabled: false,
      adapter: null,
      reason: 'admission-unavailable',
      configInvalid: true,
    };
  }
  if (type === 'none') {
    return {
      enabled: false,
      adapter: null,
      reason: 'admission-none',
      configInvalid: false,
    };
  }
  if (type === 'auto') {
    return detected === null
      ? {
          enabled: false,
          adapter: null,
          reason: 'admission-unavailable',
          configInvalid: false,
        }
      : {
          enabled: true,
          adapter: detected,
          reason: null,
          configInvalid: false,
        };
  }
  return detected === type
    ? { enabled: true, adapter: type, reason: null, configInvalid: false }
    : {
        enabled: false,
        adapter: null,
        reason: 'admission-mismatch',
        configInvalid: false,
      };
}

/** Native anchor of this client, used for the FR-13 success record. */
export function resolveAnchoredTarget(
  adapter: AdapterType,
  env: Record<string, string | undefined> = process.env,
): string | null {
  switch (adapter) {
    case 'tmux':
      return env.TMUX_PANE ?? null;
    case 'zellij':
      return env.ZELLIJ_PANE_ID ?? null;
    case 'herdr':
      return env.HERDR_PANE_ID ?? null;
    case 'kitty':
      return env.KITTY_WINDOW_ID ?? null;
    case 'cmux':
      return env.CMUX_TUI_TERMINAL_ID ?? env.CMUX_TUI_SOCKET ?? null;
  }
}

/**
 * Reflects the host server URL from the TUI SDK client (D3). Any missing or
 * malformed field fails closed: no guessed default is ever substituted.
 */
export function reflectServerBaseUrl(client: unknown): string | undefined {
  try {
    const inner = (client as { client?: { getConfig?: unknown } } | null)
      ?.client;
    const getConfig = inner?.getConfig;
    if (typeof getConfig !== 'function') return undefined;
    const config = (getConfig as () => unknown).call(inner);
    if (!isRecord(config)) return undefined;
    const baseUrl = config.baseUrl;
    return typeof baseUrl === 'string' && baseUrl.length > 0
      ? baseUrl
      : undefined;
  } catch {
    return undefined;
  }
}

/** True for the embedded-mode sentinel: there is no listener to attach to. */
export function isEmbeddedHostUrl(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, '') === EMBEDDED_HOST_BASE_URL;
}

/**
 * Equivalence health probe: the serve surface has no JSON `/health` face, so
 * `/session/status` (with the project directory) stands in (stage A 1.2).
 *
 * The directory travels as the pre-encoded `x-opencode-directory` header: the
 * server reads it raw and decodes it exactly once (instance-context
 * middleware), and the header has been accepted since v1.0.74, so it works on
 * every supported host. A `?directory=` query parameter is decoded twice
 * (`URLSearchParams.get` plus the instance-context decode), which corrupts
 * directories containing literal `%XX` sequences and would turn this gate
 * into a permanent `host-unreachable` for the affected client.
 */
export async function probeServerReachable(
  baseUrl: string,
  options: {
    directory: string;
    fetchFn?: FetchLike;
    timeoutMs?: number;
  },
): Promise<boolean> {
  const fetchFn =
    options.fetchFn ?? (globalThis.fetch as FetchLike | undefined);
  if (typeof fetchFn !== 'function') return false;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  );
  timer.unref?.();
  try {
    const url = new URL('/session/status', baseUrl);
    const response = await fetchFn(url.toString(), {
      signal: controller.signal,
      headers: options.directory
        ? { 'x-opencode-directory': encodeURIComponent(options.directory) }
        : undefined,
    });
    return response.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Projects a raw host session event onto the core event shape (FR-3). The
 * directory is only read from `properties.info.directory`; status/idle
 * envelopes carry none and are enriched by the wiring for held children.
 * Session ids are read from `properties.sessionID` when present and from
 * `properties.info.id` otherwise: created/deleted events use the latter
 * spelling (v1 SDK), idle/status the former.
 */
export function projectSessionEvent(
  type: string,
  raw: unknown,
): SessionLifecycleEvent | null {
  if (!(SESSION_EVENT_TYPES as readonly string[]).includes(type)) return null;
  if (!isRecord(raw)) return null;
  const properties = isRecord(raw.properties) ? raw.properties : undefined;
  if (!properties) return null;
  const info = isRecord(properties.info) ? properties.info : undefined;
  // `session.idle` / `session.status` carry the id as `properties.sessionID`;
  // `session.created` / `session.deleted` carry it as `properties.info.id`.
  // Accept both so created/deleted events are never dropped before the
  // lifecycle sees them.
  const sessionId =
    typeof properties.sessionID === 'string'
      ? properties.sessionID
      : typeof info?.id === 'string'
        ? info.id
        : undefined;
  if (!sessionId) return null;

  const directory =
    typeof info?.directory === 'string' ? info.directory : undefined;
  const parentSessionId =
    typeof info?.parentID === 'string' ? info.parentID : undefined;

  if (type === 'session.created') {
    return { kind: 'created', sessionId, parentSessionId, directory };
  }
  if (type === 'session.deleted') {
    return { kind: 'deleted', sessionId, parentSessionId, directory };
  }
  if (type === 'session.idle') {
    return { kind: 'idle', sessionId, directory };
  }
  const status = normalizeSessionStatus(
    isRecord(properties.status) ? properties.status.type : undefined,
  );
  return status === undefined
    ? { kind: 'status', sessionId, directory }
    : { kind: 'status', sessionId, directory, status };
}

function normalizeSessionStatus(
  value: unknown,
): SessionRuntimeStatus | undefined {
  return value === 'busy' || value === 'retry' || value === 'idle'
    ? value
    : undefined;
}

/** Last-resort defaults: pane management off, spec layout/size values. */
const FALLBACK_MULTIPLEXER_CONFIG: MultiplexerConfig = {
  type: 'none',
  layout: 'main-vertical',
  main_pane_size: 60,
};

function parseMultiplexerConfig(value: unknown): MultiplexerConfig | null {
  try {
    return MultiplexerConfigSchema.parse(value);
  } catch {
    return null;
  }
}

/** Reads the project config; loader-level failures force admission off. */
export function loadPaneConfig(directory: string): LoadedPaneConfig {
  let invalid = false;
  const config = loadPluginConfig(directory, {
    silent: true,
    onWarning: (warning) => {
      if (
        warning.kind === 'invalid-json' ||
        warning.kind === 'invalid-schema' ||
        warning.kind === 'read-error'
      ) {
        invalid = true;
      }
    },
  });
  const multiplexer = parseMultiplexerConfig(config.multiplexer ?? {});
  if (multiplexer === null) {
    return { multiplexer: FALLBACK_MULTIPLEXER_CONFIG, invalid: true };
  }
  return { multiplexer, invalid };
}

function initClientLogging(): void {
  try {
    const sessionId = `tui-${new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .slice(0, 15)}`;
    initLogger(sessionId);
  } catch {
    // Logging is best-effort; diagnostics fall back to the default sink.
  }
}

/**
 * Creates the client-local pane wiring. Admission, config, log init and the
 * host probe are resolved before returning; events flow afterwards.
 */
export async function createTuiPaneWiring(
  options: TuiPaneWiringOptions,
): Promise<TuiPaneWiring> {
  const logger = options.logger ?? PLUGIN_LOG_SINK;
  const onceGate = options.onceGate ?? processOnceGate;
  const env = options.env ?? process.env;
  const directory = options.directory;

  (options.initLogging ?? initClientLogging)();

  let loaded: LoadedPaneConfig;
  try {
    loaded = (options.loadConfig ?? loadPaneConfig)(directory);
  } catch {
    loaded = {
      multiplexer: FALLBACK_MULTIPLEXER_CONFIG,
      invalid: true,
    };
  }

  const detected = detectClientAdapter(env);
  const admission = decideAdmission(
    loaded.multiplexer.type,
    detected,
    loaded.invalid,
  );
  const configured = explicitAdapterOf(loaded.multiplexer.type);

  if (!admission.enabled) {
    logAdmissionFailure(logger, onceGate, admission, configured, detected);
    return disabledWiring(admission, detected);
  }

  const baseUrl = reflectServerBaseUrl(options.client);
  if (baseUrl === undefined || isEmbeddedHostUrl(baseUrl)) {
    // Embedded mode: no listener exists and none can be created by us, so
    // the feature stays off for this process (D3, deployment matrix).
    logHostUnreachable(logger, onceGate, admission.adapter);
    return disabledWiring(admission, detected);
  }

  const { clock, clearAll } = createTrackedClock(options.clock);
  let hostState: 'reachable' | 'unreachable' = 'unreachable';
  let nextProbeAt = 0;
  let probeInFlight: Promise<unknown> | null = null;

  const runProbe = async (): Promise<boolean> => {
    const reachable = await probeServerReachable(baseUrl, {
      directory,
      fetchFn: options.fetchFn,
      timeoutMs: options.probeTimeoutMs,
    });
    hostState = reachable ? 'reachable' : 'unreachable';
    nextProbeAt = clock.now() + HOST_REPROBE_INTERVAL_MS;
    return reachable;
  };

  const ensureReachable = async (): Promise<void> => {
    if (hostState === 'reachable') return;
    if (probeInFlight) {
      await probeInFlight;
      return;
    }
    if (clock.now() < nextProbeAt) return;
    probeInFlight = runProbe().finally(() => {
      probeInFlight = null;
    });
    await probeInFlight;
  };

  if (!(await runProbe())) {
    // A transient probe failure may recover; the first event retries at once.
    nextProbeAt = 0;
    logHostUnreachable(logger, onceGate, admission.adapter);
  }

  const adapterFactory: AdapterFactory = options.adapterFactory ?? {
    create: (type) => createAdapterFromFactory(type, loaded.multiplexer),
  };
  const ownerPid = options.ownerPid ?? process.pid;
  const ports: ClientPorts = {
    clock,
    statusReader: createSessionStatusReader(
      options.client,
      options.statusTimeoutMs,
    ),
    sessionListReader: createSessionListReader(
      options.client,
      options.listTimeoutMs,
    ),
    adapterFactory,
    resolveServerUrl: () =>
      hostState === 'reachable' ? { url: baseUrl } : { unreachable: true },
    resolveAnchoredTarget: () =>
      admission.adapter === null
        ? null
        : resolveAnchoredTarget(admission.adapter, env),
    resolvePaneTitle: (childSessionId) =>
      encodePaneTitle(ownerPid, childSessionId),
  };

  const lifecycle = new PaneLifecycle(
    ports,
    {
      directory,
      displayedSessionId: options.getDisplayedSessionId?.() ?? null,
      adapter: admission.adapter,
      layout: loaded.multiplexer.layout,
      mainPaneSize: loaded.multiplexer.main_pane_size,
      stableIdleMs: options.stableIdleMs ?? DEFAULT_STABLE_IDLE_MS,
      readiness: options.readiness ?? DEFAULT_READINESS,
    },
    logger,
  );

  let disposed = false;
  const unsubscribers: Array<() => void> = [];
  /** Child ids seen in this client's directory, for directory-less events. */
  const knownDirectories = new Map<string, string>();

  const processEvent = async (type: string, raw: unknown): Promise<void> => {
    if (disposed) return;
    const projected = projectSessionEvent(type, raw);
    if (!projected) return;
    const event = withDirectory(
      projected,
      knownDirectories,
      lifecycle,
      directory,
    );
    if (event.directory === directory) {
      rememberDirectory(knownDirectories, event.sessionId, directory);
    }
    lifecycle.setDisplayedSession(options.getDisplayedSessionId?.() ?? null);

    await ensureReachable();
    if (disposed) return;
    if (hostState !== 'reachable') {
      logHostUnreachable(logger, onceGate, admission.adapter, event.sessionId);
      return;
    }
    await lifecycle.handleEvent(event);
  };

  if (options.eventBus) {
    for (const type of SESSION_EVENT_TYPES) {
      try {
        unsubscribers.push(
          options.eventBus.on(type, (event) => {
            void processEvent(type, event);
          }),
        );
      } catch {
        // Subscription is best-effort; a host without the bus stays idle.
      }
    }
  }

  // FR-8 sweep capability: narrow the admitted adapter at first use (the
  // adapter is also created per operation by the core; this instance is only
  // used for pane scanning/closing).
  let sweepAdapterCache: SweepAdapter | null | undefined = options.sweepAdapter;
  const resolveSweepAdapter = (): SweepAdapter | null => {
    if (sweepAdapterCache !== undefined) return sweepAdapterCache;
    if (admission.adapter === null) {
      sweepAdapterCache = null;
      return sweepAdapterCache;
    }
    sweepAdapterCache = asSweepAdapter(
      adapterFactory.create(admission.adapter),
    );
    return sweepAdapterCache;
  };

  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const isSessionTerminal =
    options.isSessionTerminal ??
    createSessionTerminalProbe(options.client, options.statusTimeoutMs);

  const runSweep = async (): Promise<void> => {
    const adapter = resolveSweepAdapter();
    if (!adapter) return;
    try {
      await sweepLeftoverPanes({
        adapter,
        isProcessAlive,
        isSessionTerminal,
        logger,
      });
    } catch {
      // Fail-soft: leftovers stay for the documented user fallback.
    }
  };

  // FR-7 trigger: the bus has no reconnect signal, so reconcile runs once at
  // startup and then on a low-frequency cadence (bounded server-list diff +
  // FR-8 sweep). Disposal clears the tracked clock, stopping the chain.
  let reconcileHandle: ClockTimerHandle | null = null;
  const scheduleReconcile = (): void => {
    if (disposed) return;
    reconcileHandle = clock.setTimeout(() => {
      reconcileHandle = null;
      void runReconcile();
    }, options.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS);
  };
  const runReconcile = async (): Promise<void> => {
    if (disposed) return;
    // The route can move while the event stream is quiet; reconcile against
    // the session this client displays *now*, not the last one an event saw.
    lifecycle.setDisplayedSession(options.getDisplayedSessionId?.() ?? null);
    await ensureReachable();
    if (disposed) return;
    if (hostState === 'reachable') {
      await runSweep();
      if (disposed) return;
      await lifecycle.onReconnect();
    }
    scheduleReconcile();
  };
  void runReconcile();

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    for (const unsubscribe of unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // Best-effort teardown.
      }
    }
    if (reconcileHandle !== null) {
      clock.clearTimeout(reconcileHandle);
      reconcileHandle = null;
    }
    clearAll();
    const records = [...lifecycle.getPanes().values()];
    await Promise.allSettled(
      records.map(async (record) => {
        try {
          const adapter = adapterFactory.create(record.adapter);
          await adapter?.closePane(record.paneId);
        } catch {
          // Fail-soft: a leftover pane is handled by the FR-8 sweep.
        }
      }),
    );
  };

  return {
    admission,
    detectedAdapter: detected,
    lifecycle,
    isHostReachable: () => hostState === 'reachable',
    dispose,
  };
}

function disabledWiring(
  admission: AdmissionDecision,
  detected: AdapterType | null,
): TuiPaneWiring {
  return {
    admission,
    detectedAdapter: detected,
    lifecycle: null,
    isHostReachable: () => false,
    dispose: async () => {},
  };
}

/**
 * Status/idle envelopes carry no directory (stage A evidence 1.1); for
 * children this client holds (or has seen) the directory is already known,
 * so the core's FR-3 condition (1) still sees a match. Unknown sessions stay
 * directory-less and the core ignores them (fail-closed).
 */
function withDirectory(
  event: SessionLifecycleEvent,
  knownDirectories: ReadonlyMap<string, string>,
  lifecycle: PaneLifecycle,
  directory: string,
): SessionLifecycleEvent {
  if (event.directory !== undefined) return event;
  if (knownDirectories.has(event.sessionId)) {
    return { ...event, directory: knownDirectories.get(event.sessionId) };
  }
  if (lifecycle.getPane(event.sessionId) !== undefined) {
    return { ...event, directory };
  }
  return event;
}

/** Bounded memory: only this client's directory entries are remembered. */
function rememberDirectory(
  knownDirectories: Map<string, string>,
  sessionId: string,
  directory: string,
): void {
  if (knownDirectories.has(sessionId)) return;
  if (knownDirectories.size >= 256) {
    const oldest = knownDirectories.keys().next().value;
    if (oldest !== undefined) knownDirectories.delete(oldest);
  }
  knownDirectories.set(sessionId, directory);
}

function logAdmissionFailure(
  logger: DiagnosticLogger,
  onceGate: OnceGate,
  admission: AdmissionDecision,
  configured: AdapterType | undefined,
  detected: AdapterType | null,
): void {
  const reason = admission.reason;
  if (reason === null) return;
  const gateKey = admission.configInvalid
    ? 'admission:config-invalid'
    : `admission:${reason}`;
  if (!onceGate(gateKey)) return;
  if (admission.configInvalid) {
    logger.log(
      '[multiplexer] no pane: admission-unavailable (invalid config)',
      {
        event: DIAGNOSTIC_EVENT_NO_PANE,
        reason,
        configInvalid: true,
        detectedAdapter: detected,
      },
    );
    return;
  }
  if (reason === 'admission-mismatch') {
    logNoPane(logger, reason, {
      adapter: configured,
    });
    return;
  }
  logNoPane(logger, reason);
}

function logHostUnreachable(
  logger: DiagnosticLogger,
  onceGate: OnceGate,
  adapter: AdapterType | null,
  childSessionId?: string,
): void {
  if (!onceGate('host-unreachable')) return;
  logNoPane(logger, 'host-unreachable', {
    adapter: adapter ?? undefined,
    childSessionId,
  });
}

function createAdapterFromFactory(
  type: AdapterType,
  multiplexer: MultiplexerConfig,
): Multiplexer | null {
  try {
    return getMultiplexer({ ...multiplexer, type });
  } catch {
    return null;
  }
}

/** Wraps a clock so every pending core timer can be cleared on dispose. */
function createTrackedClock(base?: Clock): {
  clock: Clock;
  clearAll: () => void;
} {
  const source: Clock = base ?? {
    now: () => Date.now(),
    setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
    clearTimeout: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const handles = new Set<ClockTimerHandle>();
  return {
    clock: {
      now: () => source.now(),
      setTimeout: (handler, delayMs) => {
        const handle = source.setTimeout(() => {
          handles.delete(handle);
          handler();
        }, delayMs);
        handles.add(handle);
        return handle;
      },
      clearTimeout: (handle) => {
        handles.delete(handle);
        source.clearTimeout(handle);
      },
    },
    clearAll: () => {
      for (const handle of handles) source.clearTimeout(handle);
      handles.clear();
    },
  };
}

function createSessionStatusReader(
  client: unknown,
  timeoutMs = DEFAULT_STATUS_TIMEOUT_MS,
): SessionStatusReader {
  return {
    async readStatus(directory: string): Promise<SessionStatusRead> {
      const session = (client as { session?: { status?: unknown } } | null)
        ?.session;
      const status = session?.status;
      if (typeof status !== 'function') {
        return { statuses: new Map(), error: 'session.status unavailable' };
      }
      try {
        const response = await withTimeout(
          Promise.resolve(
            (status as (input: { directory: string }) => unknown).call(
              session,
              { directory },
            ),
          ),
          timeoutMs,
        );
        if (!isRecord(response)) {
          return {
            statuses: new Map(),
            error: 'invalid session-status response',
          };
        }
        if (response.error !== undefined && response.error !== null) {
          return { statuses: new Map(), error: 'session.status failed' };
        }
        const data = response.data;
        if (!isRecord(data) || Array.isArray(data)) {
          return {
            statuses: new Map(),
            error: 'invalid session-status response',
          };
        }
        const statuses = new Map<string, SessionRuntimeStatus>();
        for (const [sessionId, value] of Object.entries(data)) {
          const type = isRecord(value) ? value.type : undefined;
          if (type === 'busy' || type === 'retry' || type === 'idle') {
            statuses.set(sessionId, type);
          }
        }
        return { statuses };
      } catch (error) {
        return {
          statuses: new Map(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function createSessionListReader(
  client: unknown,
  timeoutMs = DEFAULT_LIST_TIMEOUT_MS,
): SessionListReader {
  return {
    async listSessions(directory, parentID) {
      const session = (client as { session?: { list?: unknown } } | null)
        ?.session;
      const list = session?.list;
      if (typeof list !== 'function') {
        return { sessionIds: [], error: 'session.list unavailable' };
      }
      try {
        const response = await withTimeout(
          Promise.resolve(
            (list as (input: { directory: string }) => unknown).call(session, {
              directory,
            }),
          ),
          timeoutMs,
        );
        if (!isRecord(response)) {
          return { sessionIds: [], error: 'invalid session-list response' };
        }
        if (response.error !== undefined && response.error !== null) {
          return { sessionIds: [], error: 'session.list failed' };
        }
        const data = response.data;
        if (!Array.isArray(data)) {
          return { sessionIds: [], error: 'invalid session-list response' };
        }
        const sessionIds: string[] = [];
        for (const entry of data) {
          if (!isRecord(entry) || entry.parentID !== parentID) continue;
          if (typeof entry.id === 'string') sessionIds.push(entry.id);
        }
        return { sessionIds };
      } catch (error) {
        return {
          sessionIds: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/**
 * FR-8 terminal-session probe: positive evidence only. `session.get` is
 * directory-independent (verified against a live 1.18.30 server: 200 for an
 * existing session, 404 `NotFoundError` after deletion), so a leftover pane
 * from any project can be judged safely. Every other outcome (missing API,
 * transport error, non-404 failure) fails closed and keeps the pane.
 */
function createSessionTerminalProbe(
  client: unknown,
  timeoutMs = DEFAULT_STATUS_TIMEOUT_MS,
): (childSessionId: string) => Promise<boolean> {
  return async (childSessionId: string): Promise<boolean> => {
    const session = (client as { session?: { get?: unknown } } | null)?.session;
    const get = session?.get;
    if (typeof get !== 'function') return false;
    try {
      const response = await withTimeout(
        Promise.resolve(
          (get as (input: { sessionID: string }) => unknown).call(session, {
            sessionID: childSessionId,
          }),
        ),
        timeoutMs,
      );
      if (!isRecord(response)) return false;
      // A returned session object is proof the session still exists.
      if (isRecord(response.data)) return false;
      const httpStatus = isRecord(response.response)
        ? response.response.status
        : undefined;
      if (httpStatus === 404) return true;
      const error = response.error;
      return (
        isRecord(error) &&
        (error.status === 404 || error.name === 'NotFoundError')
      );
    } catch {
      return false;
    }
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('session read timed out')),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
