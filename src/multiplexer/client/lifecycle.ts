/**
 * Client-side pane lifecycle core (tasks 2.2/2.3/2.4; FR-3/4/6/7/9/10/11).
 *
 * Pure logic: clock, session reads, adapter instances, and the server URL all
 * arrive through `ClientPorts`. The class owns the in-process pane map that
 * guarantees per-client uniqueness (FR-6), the stable-idle debounce timers
 * (FR-10), busy-driven rebuilds of idle-closed children (FR-11), and the
 * reconnect backfill that reconciles with the server session list (FR-7).
 * It never reads the environment or performs IO itself.
 */

import type { MultiplexerLayout } from '../../config/schema';
import type { Multiplexer, PaneResult } from '../types';
import {
  type DiagnosticLogger,
  logNoPane,
  logPaneCreated,
  PLUGIN_LOG_SINK,
} from './diagnostics';
import type {
  ClientPorts,
  ClockTimerHandle,
  SessionListRead,
  SessionStatusRead,
} from './ports';
import type {
  AdapterType,
  NoPaneReason,
  PaneRecord,
  SessionLifecycleEvent,
  SessionRuntimeStatus,
} from './types';

/** Bounded readiness probe policy (FR-4). */
export interface ReadinessPolicy {
  /** Maximum `readStatus` attempts before giving up. */
  maxAttempts: number;
  /** Delay between attempts, in ms. */
  retryDelayMs: number;
}

/** Construction-time projection of the client's config and view context. */
export interface PaneLifecycleConfig {
  /** Project directory this client serves (FR-3 condition ①). */
  directory: string;
  /** Session this client currently displays (FR-3 condition ②). */
  displayedSessionId: string | null;
  /** Admitted adapter (FR-9 condition ③); null when admission failed. */
  adapter: AdapterType | null;
  layout: MultiplexerLayout;
  mainPaneSize: number;
  /** Stable-idle debounce window in ms (FR-10; OQ-1 fixes the value). */
  stableIdleMs: number;
  readiness: ReadinessPolicy;
}

/** Anchor recorded when the wiring cannot resolve a native anchor. */
export const UNKNOWN_ANCHORED_TARGET = 'unknown';

/** Why a pane was closed; only idle closes stay eligible for rebuild (FR-11). */
type PaneCloseReason = 'idle' | 'deleted' | 'backfill-gone';

/** Upper bound on the closed-but-watched set, keeping memory flat. */
const MAX_REMEMBERED_CLOSED = 64;

export class PaneLifecycle {
  /** The in-process uniqueness store (FR-6), keyed by child session id. */
  private readonly panes = new Map<string, PaneRecord>();
  /** Children whose spawn is in flight; the dedup marker for FR-6. */
  private readonly spawnsInFlight = new Set<string>();
  /** Children deleted while their spawn was in flight. */
  private readonly deletedWhileSpawning = new Set<string>();
  /** Pending stable-idle debounce timers, keyed by child session id. */
  private readonly idleTimers = new Map<string, ClockTimerHandle>();
  /**
   * Children this client closed on stable idle (not terminal deletion), kept
   * so a later busy event can rebuild them (FR-11).
   */
  private readonly closedWatch = new Map<string, { parentSessionId: string }>();
  /**
   * Activity epoch per child, bumped by every held-pane event. A close
   * decision captures the epoch before its final status read and aborts when
   * the epoch moved while the read was in flight, so a stale idle snapshot
   * can never close a pane whose child just woke up.
   */
  private readonly activityEpoch = new Map<string, number>();
  private displayedSessionId: string | null;

  constructor(
    private readonly ports: ClientPorts,
    private readonly config: PaneLifecycleConfig,
    private readonly logger: DiagnosticLogger = PLUGIN_LOG_SINK,
  ) {
    this.displayedSessionId = config.displayedSessionId;
  }

  /** Updates FR-3 condition ② when the client switches displayed sessions. */
  setDisplayedSession(sessionId: string | null): void {
    this.displayedSessionId = sessionId;
  }

  /** Marks activity for a held child, invalidating in-flight close checks. */
  private bumpActivity(childSessionId: string): void {
    this.activityEpoch.set(
      childSessionId,
      (this.activityEpoch.get(childSessionId) ?? 0) + 1,
    );
  }

  /** The client-local pane for a child session, if one is tracked. */
  getPane(childSessionId: string): PaneRecord | undefined {
    return this.panes.get(childSessionId);
  }

  /** Read-only view of every pane tracked by this client. */
  getPanes(): ReadonlyMap<string, PaneRecord> {
    return this.panes;
  }

  /**
   * Routes one projected host event (FR-3).
   *
   * New-pane eligibility requires all three conditions: the event belongs to
   * this client's directory, its `parentID` is the displayed session, and
   * admission passed. For children this client already holds, status/idle/
   * deleted keep being processed regardless of the displayed session, so a
   * pane cannot leak after the user switches views.
   */
  async handleEvent(event: SessionLifecycleEvent): Promise<void> {
    if (!event.sessionId) return;

    const record = this.panes.get(event.sessionId);
    if (record) {
      await this.handleHeldPaneEvent(event, record);
      return;
    }

    // Events outside this client's directory are not ours to act on; the
    // global event bus broadcasts every project's events (stage A evidence).
    if (!this.isOurDirectory(event)) return;

    if (event.kind === 'deleted') {
      // A deletion racing the spawn is remembered and applied on completion.
      if (this.spawnsInFlight.has(event.sessionId)) {
        this.deletedWhileSpawning.add(event.sessionId);
      }
      // Terminal: a deleted child is never rebuilt (FR-10/FR-11).
      this.closedWatch.delete(event.sessionId);
      return;
    }

    if (event.kind === 'status') {
      await this.handleClosedChildBusy(event);
      return;
    }
    if (event.kind !== 'created') return;

    if (
      event.parentSessionId === undefined ||
      event.parentSessionId !== this.displayedSessionId
    ) {
      logNoPane(this.logger, 'not-our-child', {
        childSessionId: event.sessionId,
        parentSessionId: event.parentSessionId,
        adapter: this.config.adapter ?? undefined,
      });
      return;
    }

    // Admission failed: the wiring already emitted the one-time diagnostic
    // (FR-9), so per-event handling stays silent here.
    if (this.config.adapter === null) return;

    // In-flight spawn for this child: a replayed or concurrent delivery must
    // not produce a second pane (FR-6).
    if (this.spawnsInFlight.has(event.sessionId)) return;

    await this.createPane(event.sessionId, event.parentSessionId);
  }

  /**
   * Reconciles local pane state with the server after the event stream
   * reconnects (FR-7). The server session list is authoritative for the
   * displayed parent; the same eligibility and dedup guards as the event path
   * apply, so compensation can never produce a second pane (FR-6).
   */
  async onReconnect(): Promise<void> {
    const parentSessionId = this.displayedSessionId;
    if (parentSessionId === null || this.config.adapter === null) return;

    const list = await this.listSessions(
      this.config.directory,
      parentSessionId,
    );
    if (list.error) return; // unverifiable: keep local state (fail-closed)
    const serverChildIds = new Set(list.sessionIds);

    // Local panes whose child is gone from the server are terminal: close.
    for (const [childSessionId, record] of [...this.panes]) {
      if (!serverChildIds.has(childSessionId)) {
        await this.closePane(childSessionId, record, 'backfill-gone');
      }
    }

    // Already-held children need no action beyond the FR-13 diagnostic.
    for (const childSessionId of serverChildIds) {
      if (!this.panes.has(childSessionId)) continue;
      logNoPane(this.logger, 'backfill-skipped', {
        childSessionId,
        parentSessionId,
        adapter: this.config.adapter,
      });
    }

    // Closed-but-watched children: drop the ones the server no longer has,
    // and rebuild the ones that turned busy while the stream was down (their
    // busy event was lost, so it is recovered from the live status map).
    if (this.closedWatch.size > 0) {
      const read = await this.readStatus(this.config.directory);
      const statuses = read.error ? null : read.statuses;
      for (const [childSessionId, watched] of [...this.closedWatch]) {
        if (!serverChildIds.has(childSessionId)) {
          this.closedWatch.delete(childSessionId);
          continue;
        }
        if (watched.parentSessionId !== parentSessionId) continue;
        if (statuses?.get(childSessionId) !== 'busy') continue;
        if (this.spawnsInFlight.has(childSessionId)) continue;
        await this.createPane(childSessionId, watched.parentSessionId);
      }
    }

    // Backfill children the server has but this client does not track.
    for (const childSessionId of serverChildIds) {
      if (this.panes.has(childSessionId)) continue;
      if (this.spawnsInFlight.has(childSessionId)) continue;
      if (this.closedWatch.has(childSessionId)) continue;
      await this.createPane(childSessionId, parentSessionId);
    }
  }

  /**
   * Status/idle/deleted handling for children this client already holds.
   * Condition ② is deliberately not required here (FR-3), only ① remains.
   */
  private async handleHeldPaneEvent(
    event: SessionLifecycleEvent,
    record: PaneRecord,
  ): Promise<void> {
    if (event.kind === 'created') return; // replay: the pane is already held
    if (!this.isOurDirectory(event)) return;

    if (event.kind === 'deleted') {
      this.bumpActivity(event.sessionId);
      await this.closePane(event.sessionId, record, 'deleted');
      return;
    }
    if (event.kind === 'idle') {
      this.bumpActivity(event.sessionId);
      this.scheduleStableIdleClose(event.sessionId, record);
      return;
    }
    if (event.kind !== 'status') return;

    if (event.status === 'idle') {
      this.bumpActivity(event.sessionId);
      this.scheduleStableIdleClose(event.sessionId, record);
      return;
    }
    if (event.status === 'busy' || event.status === 'retry') {
      this.bumpActivity(event.sessionId);
      this.cancelIdleClose(event.sessionId);
    }
  }

  /**
   * FR-11: a child this client closed on stable idle that turns busy again is
   * rebuilt, but only while its parent is still the displayed session. The
   * rebuild goes through the normal creation path, so the anchor is
   * re-resolved rather than replayed from memory.
   */
  private async handleClosedChildBusy(
    event: SessionLifecycleEvent,
  ): Promise<void> {
    if (event.status !== 'busy') return;
    const watched = this.closedWatch.get(event.sessionId);
    if (watched === undefined) return;
    if (watched.parentSessionId !== this.displayedSessionId) return;
    if (this.config.adapter === null) return;
    if (this.spawnsInFlight.has(event.sessionId)) return;

    await this.createPane(event.sessionId, watched.parentSessionId);
  }

  private isOurDirectory(event: SessionLifecycleEvent): boolean {
    return event.directory === this.config.directory;
  }

  private async createPane(
    childSessionId: string,
    parentSessionId: string,
  ): Promise<void> {
    const adapterType = this.config.adapter;
    if (adapterType === null) return;

    // Creation supersedes any pending rebuild watch for this child.
    this.closedWatch.delete(childSessionId);
    this.spawnsInFlight.add(childSessionId);
    try {
      // Host reachability first: embedded mode (no listener) must stay
      // distinguishable from a readiness timeout (D3/FR-13).
      const serverUrl = this.ports.resolveServerUrl();
      if (!serverUrl.url || serverUrl.unreachable === true) {
        logNoPane(this.logger, 'host-unreachable', {
          childSessionId,
          parentSessionId,
          adapter: adapterType,
        });
        return;
      }

      const adapter = this.ports.adapterFactory.create(adapterType);
      if (!adapter) {
        logNoPane(this.logger, 'adapter-unavailable', {
          childSessionId,
          parentSessionId,
          adapter: adapterType,
        });
        return;
      }

      const readyStatus = await this.waitForReady(
        this.config.directory,
        childSessionId,
      );
      if (readyStatus === null) {
        logNoPane(this.logger, 'readiness-timeout', {
          childSessionId,
          parentSessionId,
          adapter: adapterType,
        });
        return;
      }

      // Deleted while waiting for readiness: never create the pane (FR-10).
      if (this.deletedWhileSpawning.has(childSessionId)) return;

      const result = await this.spawn(
        adapter,
        childSessionId,
        parentSessionId,
        serverUrl.url,
      );
      if (!result.success || !result.paneId) {
        logNoPane(this.logger, this.adapterFailureReason(result.error), {
          childSessionId,
          parentSessionId,
          adapter: adapterType,
        });
        return;
      }

      const record: PaneRecord = {
        childSessionId,
        parentSessionId,
        paneId: result.paneId,
        adapter: adapterType,
        anchoredTarget: this.resolveAnchoredTarget(),
        status: 'active',
      };
      this.panes.set(childSessionId, record);
      logPaneCreated(this.logger, record);

      // Deleted during the spawn itself: register, then close right away.
      if (this.deletedWhileSpawning.delete(childSessionId)) {
        await this.closePane(childSessionId, record, 'deleted');
        return;
      }

      // A child that is already idle when its pane appears (e.g. backfilled
      // after the stream was down) must still follow the FR-10 close rule.
      if (readyStatus === 'idle') {
        this.scheduleStableIdleClose(childSessionId, record);
      }

      await this.applyLayout(adapter);
    } finally {
      this.spawnsInFlight.delete(childSessionId);
      this.deletedWhileSpawning.delete(childSessionId);
    }
  }

  private async spawn(
    adapter: Multiplexer,
    childSessionId: string,
    parentSessionId: string,
    serverUrl: string,
  ): Promise<PaneResult> {
    try {
      // The description doubles as the initial pane title. The wiring injects
      // the encoded owner pid + child id (FR-8 metadata); the core stays free
      // of environment reads and falls back to the child id when absent.
      const description =
        this.ports.resolvePaneTitle?.(childSessionId) ?? childSessionId;
      return await adapter.spawnPane(
        childSessionId,
        description,
        serverUrl,
        this.config.directory,
        { parentSessionId },
      );
    } catch {
      return { success: false, error: 'hard' };
    }
  }

  private async applyLayout(adapter: Multiplexer): Promise<void> {
    try {
      await adapter.applyLayout(this.config.layout, this.config.mainPaneSize);
    } catch {
      // Layout is cosmetic; a created pane must never fail over it.
    }
  }

  private resolveAnchoredTarget(): string {
    try {
      const target = this.ports.resolveAnchoredTarget?.();
      return target ? target : UNKNOWN_ANCHORED_TARGET;
    } catch {
      return UNKNOWN_ANCHORED_TARGET;
    }
  }

  private adapterFailureReason(error: PaneResult['error']): NoPaneReason {
    if (error === 'unavailable') return 'adapter-unavailable';
    if (error === 'not_found') return 'adapter-not-found';
    // `hard`, `invalid_state`, and an absent error are all hard failures.
    return 'adapter-hard';
  }

  /**
   * Bounded readiness probe (FR-4): every attempt carries the session
   * directory, and the session must appear in the live status map. Returns
   * the observed status, or null when the bound elapsed.
   *
   * This gate stays deliberately strict: its question is "is the child
   * reachable?", so absence fails closed with a readiness timeout. That is a
   * different question from the pre-close re-check below ("is the child still
   * not busy?"), where a valid absent entry means quiescent. Do not relax
   * this probe to accept absence.
   */
  private async waitForReady(
    directory: string,
    childSessionId: string,
  ): Promise<SessionRuntimeStatus | null> {
    const { maxAttempts, retryDelayMs } = this.config.readiness;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const read = await this.readStatus(directory);
      const status = read.error ? undefined : read.statuses.get(childSessionId);
      if (status !== undefined) return status;
      if (attempt < maxAttempts) await this.delay(retryDelayMs);
    }
    return null;
  }

  private async listSessions(
    directory: string,
    parentID: string,
  ): Promise<SessionListRead> {
    try {
      return await this.ports.sessionListReader.listSessions(
        directory,
        parentID,
      );
    } catch {
      return { sessionIds: [], error: 'session list read failed' };
    }
  }

  private async readStatus(directory: string): Promise<SessionStatusRead> {
    try {
      return await this.ports.statusReader.readStatus(directory);
    } catch {
      return { statuses: new Map(), error: 'session status read failed' };
    }
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.ports.clock.setTimeout(resolve, milliseconds);
    });
  }

  private scheduleStableIdleClose(
    childSessionId: string,
    record: PaneRecord,
  ): void {
    if (record.status !== 'active') return;
    // Replayed idle edges must not extend the window indefinitely.
    if (this.idleTimers.has(childSessionId)) return;

    const handle = this.ports.clock.setTimeout(() => {
      this.idleTimers.delete(childSessionId);
      void this.closeIfStillIdle(childSessionId);
    }, this.config.stableIdleMs);
    this.idleTimers.set(childSessionId, handle);
  }

  private cancelIdleClose(childSessionId: string): void {
    const handle = this.idleTimers.get(childSessionId);
    if (handle === undefined) return;
    this.idleTimers.delete(childSessionId);
    this.ports.clock.clearTimeout(handle);
  }

  private async closeIfStillIdle(childSessionId: string): Promise<void> {
    const record = this.panes.get(childSessionId);
    if (record?.status !== 'active') return;

    // Re-check right before closing (FR-10). On a valid read, an absent
    // session is quiescent, not busy: opencode removes the entry from
    // `/session/status` when a turn ends (real-host semantics; see
    // `src/utils/session-runtime-status.ts` — "An absent session in a valid
    // response is quiescent, not terminal"). So absence allows the close,
    // while `busy`/`retry` keeps the pane. An unverifiable read keeps the
    // pane (fail-closed, I3).
    const epoch = this.activityEpoch.get(childSessionId) ?? 0;
    const read = await this.readStatus(this.config.directory);
    if (read.error) return;
    // Any held-pane event while the read was in flight (a busy/retry edge, a
    // fresh idle, a deletion) invalidates the decision: the snapshot may
    // predate it, and that event has already been consumed.
    if ((this.activityEpoch.get(childSessionId) ?? 0) !== epoch) return;
    if (this.panes.get(childSessionId)?.status !== 'active') return;
    const status = read.statuses.get(childSessionId);
    if (status === 'busy' || status === 'retry') return;

    await this.closePane(childSessionId, record, 'idle');
  }

  private async closePane(
    childSessionId: string,
    record: PaneRecord,
    reason: PaneCloseReason,
  ): Promise<void> {
    if (record.status === 'closing') return;
    record.status = 'closing';
    this.cancelIdleClose(childSessionId);

    const adapter = this.ports.adapterFactory.create(record.adapter);
    if (!adapter) {
      record.status = 'active';
      return;
    }

    let closed = false;
    try {
      closed = await adapter.closePane(record.paneId);
    } catch {
      closed = false;
    }

    if (closed) {
      this.panes.delete(childSessionId);
      this.activityEpoch.delete(childSessionId);
      // Only idle closes are rebuildable; deleted/gone children are terminal.
      if (reason === 'idle') {
        this.rememberClosed(childSessionId, record.parentSessionId);
      }
      return;
    }
    // Close failed: keep tracking so a later event can retry; dropping the
    // record while the pane may still exist would break FR-6 uniqueness.
    record.status = 'active';
  }

  /** Remembers an idle-closed child for FR-11 rebuilds, bounded in size. */
  private rememberClosed(
    childSessionId: string,
    parentSessionId: string,
  ): void {
    this.closedWatch.delete(childSessionId);
    this.closedWatch.set(childSessionId, { parentSessionId });
    if (this.closedWatch.size <= MAX_REMEMBERED_CLOSED) return;
    const oldest = this.closedWatch.keys().next().value;
    if (oldest !== undefined) this.closedWatch.delete(oldest);
  }
}
