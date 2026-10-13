/**
 * v2 host adapter for the client-side pane lifecycle.
 *
 * The v2 TUI exposes a different surface than the v1 `TuiPluginApi`: session
 * events arrive through `ctx.data.on(...)` with v2 event names, reads flow
 * through the authenticated `ctx.client`, and the host access mode is only
 * visible on the process argv. This module projects those onto the
 * host-agnostic wiring seams; the lifecycle core and the multiplexer adapters
 * stay untouched (design D1).
 */

import { isRecord } from '../../utils/guards';
import type {
  SessionListEntry,
  SessionListRead,
  SessionListReader,
  SessionStatusRead,
  SessionStatusReader,
} from './ports';
import type { TuiPaneWiringOptions } from './tui-wiring';
import type { SessionLifecycleEvent, SessionRuntimeStatus } from './types';

/** Classified host access mode; `invalid` fails closed (no panes). */
export type V2HostModeDetection =
  | { mode: 'shared' }
  | { mode: 'remote'; serverUrl: string }
  | { mode: 'standalone' }
  | { mode: 'invalid'; reason: string };

interface ServerFlag {
  present: boolean;
  url?: string;
}

function readServerFlag(argv: readonly string[]): ServerFlag {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--server') {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) return { present: true };
      return { present: true, url: next };
    }
    if (typeof arg === 'string' && arg.startsWith('--server=')) {
      return { present: true, url: arg.slice('--server='.length) };
    }
  }
  return { present: false };
}

/**
 * Classifies the v2 host from its own argv (spike-verified on 2.0.18):
 * `--standalone` never exposes a joinable server for panes, `--server <url>`
 * carries the explicit URL, and the bare default discovers/starts the shared
 * background service.
 *
 * The asynchronous twin `client.server.info().urls` cannot discriminate:
 * standalone also reports a loopback URL (an ephemeral private one), so argv
 * stays the primary signal and `server.info()` is only cross-checked for URL
 * resolution. Mutually exclusive or malformed flags fail closed.
 */
export function detectV2HostMode(argv: readonly string[]): V2HostModeDetection {
  const standalone = argv.includes('--standalone');
  const server = readServerFlag(argv);
  if (standalone && server.present) {
    return {
      mode: 'invalid',
      reason: '--standalone and --server are mutually exclusive',
    };
  }
  if (standalone) return { mode: 'standalone' };
  if (server.present) {
    const url = server.url;
    if (url === undefined || url.length === 0) {
      return { mode: 'invalid', reason: '--server requires a URL' };
    }
    return { mode: 'remote', serverUrl: url };
  }
  return { mode: 'shared' };
}

/** Compacts a mode detection into the diagnostic detail payload (FR-13). */
export function describeV2HostMode(mode: V2HostModeDetection): {
  mode: string;
  reason?: string;
} {
  return mode.mode === 'invalid'
    ? { mode: mode.mode, reason: mode.reason }
    : { mode: mode.mode };
}

/** Event types the v2 host subscribes to for the pane lifecycle (design D4). */
export const V2_SESSION_EVENT_TYPES = [
  'session.created',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.idle',
  'session.deleted',
] as const;

interface V2EventEnvelope {
  data?: {
    sessionID?: unknown;
    parentID?: unknown;
    agent?: unknown;
    location?: { directory?: unknown } | null;
  } | null;
  sessionID?: unknown;
  location?: { directory?: unknown } | null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Projects one v2 host event onto the core event shape (design D4).
 *
 * `session.created` carries the child's `parentID`, `agent` and
 * `location.directory`. Execution events carry only the session id — the
 * wiring re-attaches the directory from its child→directory map, exactly like
 * the v1 stage-A path — and terminal execution states map to the idle edge.
 * Unknown kinds return null so the wiring ignores them. Cross-location
 * filtering stays in the lifecycle core (same-directory condition), so this
 * projection never drops events on its own.
 *
 * Real-machine calibration (2026-09-29, opencode 2.0.18, tmux host): a reused
 * background child produced `session.created` → pane, and the pane closed
 * after the stable-idle window once the child went idle; terminal execution
 * states behaved as idle edges. Re-check this composition on host updates
 * (evidence: /tmp/opencode/v2pane-e2e/evidence/).
 */
export function projectV2SessionEvent(
  type: string,
  event: unknown,
): SessionLifecycleEvent | null {
  const envelope = (event ?? {}) as V2EventEnvelope;
  const data = envelope.data ?? {};
  const sessionId =
    readString(data.sessionID) ?? readString(envelope.sessionID);
  if (sessionId === undefined) return null;
  switch (type) {
    case 'session.created': {
      const directory =
        readString(envelope.location?.directory) ??
        readString(data.location?.directory);
      const parentSessionId = readString(data.parentID);
      const subagentType = readString(data.agent);
      return {
        kind: 'created',
        sessionId,
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
        ...(directory === undefined ? {} : { directory }),
        ...(subagentType === undefined ? {} : { subagentType }),
      };
    }
    case 'session.execution.started':
      return { kind: 'status', sessionId, status: 'busy' };
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted':
      return { kind: 'status', sessionId, status: 'idle' };
    case 'session.idle':
      return { kind: 'idle', sessionId };
    case 'session.deleted':
      return { kind: 'deleted', sessionId };
    default:
      return null;
  }
}

/** Structural subset of the v2 TUI `OpenCodeClient` the pane host uses. */
interface V2ClientLike {
  server?: { info?: () => Promise<unknown> };
  session?: {
    list?: (input?: Record<string, unknown>) => Promise<unknown>;
    active?: () => Promise<unknown>;
    get?: (input: { sessionID: string }) => Promise<unknown>;
  };
}

/** Structural subset of the v2 TUI `data` domain. */
export interface V2DataLike {
  on?: (type: string, handler: (event: unknown) => void) => unknown;
}

/** Structural subset of the v2 TUI context the pane host consumes. */
export interface V2PaneHostContext {
  location?: { directory?: string } | null;
  client?: unknown;
  data?: V2DataLike | null;
  ui?: { router?: { current?: () => unknown } } | null;
  env?: Record<string, string | undefined>;
  argv?: readonly string[];
}

export interface V2PaneHostSetup {
  mode: V2HostModeDetection;
  /** Wiring options when this host can serve panes; null otherwise. */
  options: TuiPaneWiringOptions | null;
}

function readSessionArray(value: unknown): Array<Record<string, unknown>> {
  const data = isRecord(value) && 'data' in value ? value.data : value;
  if (!Array.isArray(data)) return [];
  return data.filter((entry): entry is Record<string, unknown> =>
    isRecord(entry),
  );
}

function readActiveIds(value: unknown): Set<string> | undefined {
  const record = isRecord(value) && isRecord(value.data) ? value.data : value;
  return isRecord(record) && !Array.isArray(record)
    ? new Set(Object.keys(record))
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readServerInfo(
  client: V2ClientLike | undefined,
): Promise<unknown> {
  const info = client?.server?.info;
  if (typeof info !== 'function') return undefined;
  try {
    return await info.call(client?.server);
  } catch {
    return undefined;
  }
}

function readServerUrls(info: unknown): string[] {
  if (!isRecord(info) || !Array.isArray(info.urls)) return [];
  return info.urls.filter(
    (url): url is string => typeof url === 'string' && url.length > 0,
  );
}

/**
 * Resolves the base URL the wiring reflects. Remote mode trusts the argv
 * `--server` value (the parent connected with exactly it); shared mode reads
 * the running service's own addresses through the authenticated client.
 */
export async function resolveV2BaseUrl(
  detection: V2HostModeDetection,
  client: V2ClientLike | undefined,
): Promise<string | undefined> {
  if (detection.mode === 'remote') return detection.serverUrl;
  if (detection.mode !== 'shared') return undefined;
  const info = await readServerInfo(client);
  return readServerUrls(info)[0];
}

/** Authenticated liveness probe: `server.info()` answers on the live client. */
export function createV2HostProbe(
  client: V2ClientLike | undefined,
): () => Promise<boolean> {
  return async () => (await readServerInfo(client)) !== undefined;
}

const V2_LIST_PAGE = 200;
const V2_LIST_MAX_PAGES = 25;

/**
 * Status = the newest directory page (idle) plus every active id (busy).
 * Newest-first keeps newly created idle children visible for readiness.
 */
export function createV2StatusReader(
  client: V2ClientLike | undefined,
): SessionStatusReader {
  return {
    async readStatus(directory: string): Promise<SessionStatusRead> {
      const list = client?.session?.list;
      const active = client?.session?.active;
      if (typeof list !== 'function' || typeof active !== 'function') {
        return { statuses: new Map(), error: 'v2 session API unavailable' };
      }
      try {
        const [listed, running] = await Promise.all([
          list.call(client?.session, {
            directory,
            order: 'desc',
            limit: V2_LIST_PAGE,
          }),
          active.call(client?.session),
        ]);
        const statuses = new Map<string, SessionRuntimeStatus>();
        for (const entry of readSessionArray(listed)) {
          const id = readString(entry.id);
          if (id === undefined) continue;
          statuses.set(id, 'idle');
        }
        const activeIds = readActiveIds(running);
        if (activeIds === undefined) {
          return { statuses: new Map(), error: 'invalid v2 active response' };
        }
        for (const id of activeIds) statuses.set(id, 'busy');
        return { statuses };
      } catch (error) {
        return { statuses: new Map(), error: errorMessage(error) };
      }
    },
  };
}

/** FR-7 backfill: all child pages, oldest-first so metadata updates stay ahead. */
export function createV2SessionListReader(
  client: V2ClientLike | undefined,
): SessionListReader {
  return {
    async listSessions(
      directory: string,
      parentID: string,
    ): Promise<SessionListRead> {
      const list = client?.session?.list;
      if (typeof list !== 'function') {
        return { sessions: [], error: 'v2 session API unavailable' };
      }
      try {
        let query: Record<string, unknown> = {
          directory,
          parentID,
          order: 'asc',
          limit: V2_LIST_PAGE,
        };
        const sessions: SessionListEntry[] = [];
        for (let page = 0; page < V2_LIST_MAX_PAGES; page += 1) {
          const response = await list.call(client?.session, query);
          const entries = Array.isArray(response)
            ? response
            : isRecord(response)
              ? response.data
              : undefined;
          if (!Array.isArray(entries))
            throw new Error('invalid v2 session list response');
          for (const entry of readSessionArray(entries)) {
            const id = readString(entry.id);
            if (id === undefined) continue;
            const agent = readString(entry.agent);
            sessions.push(
              agent === undefined
                ? { sessionId: id }
                : { sessionId: id, subagentType: agent },
            );
          }
          const next =
            isRecord(response) && isRecord(response.cursor)
              ? readString(response.cursor.next)
              : undefined;
          if (entries.length < V2_LIST_PAGE) return { sessions };
          if (next === undefined)
            throw new Error('v2 session list missing next cursor');
          query = { cursor: next, limit: V2_LIST_PAGE };
        }
        throw new Error('v2 session list page limit exceeded');
      } catch (error) {
        return { sessions: [], error: errorMessage(error) };
      }
    },
  };
}

/**
 * FR-8 terminal probe: `session.get` resolving proves the session exists;
 * a not-found rejection proves it is gone. Every other outcome keeps the
 * pane (fail-closed), matching the v1 probe's contract.
 */
export function createV2TerminalProbe(
  client: V2ClientLike | undefined,
): (childSessionId: string) => Promise<boolean> {
  return async (childSessionId: string): Promise<boolean> => {
    const get = client?.session?.get;
    if (typeof get !== 'function') return false;
    try {
      await get.call(client?.session, { sessionID: childSessionId });
      return false;
    } catch (error) {
      return isNotFoundError(error);
    }
  };
}

function isNotFoundError(error: unknown): boolean {
  if (isRecord(error)) {
    if (error.status === 404) return true;
    if (error.name === 'NotFoundError') return true;
    if (error._tag === 'SessionNotFoundError') return true;
    if (error.cause !== undefined && error.cause !== error) {
      return isNotFoundError(error.cause);
    }
    return false;
  }
  const text = error instanceof Error ? error.message : String(error);
  return text.includes('NotFound') || text.includes('404');
}

/**
 * Subscribes to the v2 event set and feeds already-projected lifecycle
 * events. Subscription is best-effort per type; the returned disposer
 * unsubscribes everything it managed to register.
 */
export function subscribeV2SessionEvents(
  data: V2DataLike | null | undefined,
  handler: (event: SessionLifecycleEvent) => void,
): () => void {
  const on = data?.on;
  if (typeof on !== 'function') return () => {};
  const unsubscribers: Array<() => void> = [];
  for (const type of V2_SESSION_EVENT_TYPES) {
    try {
      const off = on.call(data, type, (event: unknown) => {
        const projected = projectV2SessionEvent(type, event);
        if (projected) handler(projected);
      });
      if (typeof off === 'function') {
        unsubscribers.push(off as () => void);
      }
    } catch {
      // Subscription is best-effort; a host without the event is skipped.
    }
  }
  return () => {
    for (const unsubscribe of unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // Best-effort teardown.
      }
    }
  };
}

function resolveV2DisplayedSession(ctx: V2PaneHostContext): string | undefined {
  const route = ctx.ui?.router?.current?.();
  if (!isRecord(route) || route.type !== 'session') return undefined;
  return readString(route.sessionID);
}

/**
 * Builds the wiring options for a v2 TUI host, or reports why panes are not
 * possible here. `standalone` and malformed modes never get a wiring: the
 * private stdio server cannot be joined by a pane viewer (deployment matrix).
 */
export async function buildV2PaneWiringOptions(
  ctx: V2PaneHostContext,
): Promise<V2PaneHostSetup> {
  const argv = ctx.argv ?? process.argv;
  const mode = detectV2HostMode(argv);
  if (mode.mode === 'standalone' || mode.mode === 'invalid') {
    return { mode, options: null };
  }
  const client = ctx.client as V2ClientLike | undefined;
  const baseUrl = await resolveV2BaseUrl(mode, client);
  if (baseUrl === undefined) {
    return {
      mode: { mode: 'invalid', reason: 'server URL unavailable' },
      options: null,
    };
  }
  const env = ctx.env ?? process.env;
  const password = env.OPENCODE_PASSWORD ?? env.OPENCODE_SERVER_PASSWORD;
  return {
    mode,
    options: {
      directory: ctx.location?.directory ?? process.cwd(),
      getDirectory: () => ctx.location?.directory ?? process.cwd(),
      getDisplayedSessionId: () => resolveV2DisplayedSession(ctx),
      baseUrl,
      probeHost: createV2HostProbe(client),
      statusReader: createV2StatusReader(client),
      sessionListReader: createV2SessionListReader(client),
      sessionEvents: (handler) => subscribeV2SessionEvents(ctx.data, handler),
      isSessionTerminal: createV2TerminalProbe(client),
      viewerFlavor: mode.mode === 'remote' ? 'v2-remote' : 'v2-shared',
      ...(password === undefined ? {} : { viewerPassword: password }),
      env,
    },
  };
}
