/**
 * Client-side pane lifecycle core: shared types (FR-1..FR-13).
 *
 * Pure type surface plus the frozen diagnostic enumeration — no IO, no
 * environment reads at module load. The core is wired only from the TUI entry
 * (`src/tui.ts`); the server entry's dependency graph must never reach it.
 */

import type { Multiplexer } from '../types';

/** Multiplexer adapter kinds, shared with the adapter layer. */
export type AdapterType = Multiplexer['type'];

/** Live session status, mirroring the server's `/session/status` values. */
export type SessionRuntimeStatus = 'busy' | 'retry' | 'idle';

/**
 * Lifecycle state of one client-owned pane record:
 * - `spawning`: spawn in flight (dedupes concurrent events for one child)
 * - `active`: pane exists and is managed by this client
 * - `closing`: close in flight; the record is dropped once the pane is gone
 */
export type PaneStatus = 'spawning' | 'active' | 'closing';

/** Identity fields of a created pane (the FR-13 success record fields). */
export interface PaneIdentity {
  childSessionId: string;
  parentSessionId: string;
  paneId: string;
  adapter: AdapterType;
  /** Multiplexer-native anchor (pane/tab/window) that was split. */
  anchoredTarget: string;
}

/** One client-local pane, keyed by `childSessionId` in the in-process Map. */
export interface PaneRecord extends PaneIdentity {
  status: PaneStatus;
}

/** The four host events the client consumes (FR-3). */
export type SessionLifecycleEventKind =
  | 'created'
  | 'status'
  | 'idle'
  | 'deleted';

/** Minimal projection of a host session event. */
export interface SessionLifecycleEvent {
  kind: SessionLifecycleEventKind;
  sessionId: string;
  parentSessionId?: string;
  /**
   * Project directory the event belongs to. The raw TUI `api.event` envelope
   * carries no top-level `directory`: it lives at `properties.info.directory`
   * (stage A evidence 1.1); wiring must project it from there.
   */
  directory?: string;
  /** Present for `status` events. */
  status?: SessionRuntimeStatus;
}

/**
 * Every reason a pane was not created; each must stay distinguishable in logs
 * (FR-13). Kept as a runtime array so tests can assert the full enumeration.
 */
export const NO_PANE_REASONS = [
  'admission-none',
  'admission-mismatch',
  'admission-unavailable',
  'not-our-child',
  'host-unreachable',
  'readiness-timeout',
  'adapter-unavailable',
  'adapter-not-found',
  'adapter-hard',
  'backfill-skipped',
] as const;

export type NoPaneReason = (typeof NO_PANE_REASONS)[number];
