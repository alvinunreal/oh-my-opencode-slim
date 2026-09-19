/**
 * Injected IO surface of the client-side pane lifecycle core (NFR-3).
 *
 * Nothing in this module touches the environment, the network, or real
 * timers: the wiring layer supplies every port.
 */

import type { Multiplexer } from '../types';
import type { AdapterType, SessionRuntimeStatus } from './types';

/** Opaque handle returned by `Clock.setTimeout` and passed back to clear. */
export type ClockTimerHandle = unknown;

/** Injected time source; the core never creates real timers directly. */
export interface Clock {
  now(): number;
  setTimeout(handler: () => void, delayMs: number): ClockTimerHandle;
  clearTimeout(handle: ClockTimerHandle): void;
}

/** Result of one `/session/status` read. */
export interface SessionStatusRead {
  /** Live statuses keyed by session id; empty when `error` is set. */
  statuses: ReadonlyMap<string, SessionRuntimeStatus>;
  /** Set when the read failed (transport error, invalid payload, timeout). */
  error?: string;
}

/**
 * Reads live session statuses for one directory. The implementation must pass
 * `directory` through to `session.status({ query: { directory } })` (FR-4).
 */
export interface SessionStatusReader {
  readStatus(directory: string): Promise<SessionStatusRead>;
}

/** Result of one session-list read. */
export interface SessionListRead {
  /** Child session ids whose `parentID` equals the requested parent. */
  sessionIds: readonly string[];
  /** Set when the read failed. */
  error?: string;
}

/** Reads the server session list for backfill compensation (FR-7). */
export interface SessionListReader {
  listSessions(directory: string, parentID: string): Promise<SessionListRead>;
}

/** Resolves a client-local adapter instance; `null` means unavailable here. */
export interface AdapterFactory {
  create(type: AdapterType): Multiplexer | null;
}

/** Reflected server URL; a guessed default is never substituted (D3). */
export interface ServerUrlResolution {
  /** Usable base URL for `opencode attach`; absent when unreachable. */
  url?: string;
  /** True for the embedded-mode sentinel: no listener to attach to. */
  unreachable?: boolean;
}

/** Reflects the host's server URL and its reachability. */
export type ServerUrlResolver = () => ServerUrlResolution;

/** The complete injected surface of the pane lifecycle core. */
export interface ClientPorts {
  readonly clock: Clock;
  readonly statusReader: SessionStatusReader;
  readonly sessionListReader: SessionListReader;
  readonly adapterFactory: AdapterFactory;
  readonly resolveServerUrl: ServerUrlResolver;
  /**
   * Optional: resolves the multiplexer-native anchor (the parent pane/tab/
   * window a spawn would split) for the FR-13 success record. The wiring reads
   * it from the admitted adapter's client-local environment. When absent or
   * empty the record falls back to `'unknown'` — diagnostics never block pane
   * creation.
   */
  readonly resolveAnchoredTarget?: () => string | null;
  /**
   * Optional: the pane title passed to the adapter as the spawn description
   * (FR-8). The wiring supplies the encoded owner pid + child session id; the
   * core never reads the process environment itself. Without it the child
   * session id remains the description.
   */
  readonly resolvePaneTitle?: (childSessionId: string) => string;
}
