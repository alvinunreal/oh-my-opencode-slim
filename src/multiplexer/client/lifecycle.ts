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
import type { Multiplexer, PaneResult, PaneSpawnOptions } from '../types';
import {
  type DiagnosticLogger,
  logNoPane,
  logPaneClosed,
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
  /**
   * Viewer spawn options, including the in-process `v2-remote` password.
   * The wiring supplies the surface; adapters default to v1/full TUI.
   */
  viewer?: Pick<
    PaneSpawnOptions,
    'viewerFlavor' | 'viewerPassword' | 'viewerSurface'
  >;
}

/** Anchor recorded when the wiring cannot resolve a native anchor. */
export const UNKNOWN_ANCHORED_TARGET = 'unknown';

/** Why a pane was closed; only idle closes stay eligible for rebuild (FR-11). */
type PaneCloseReason = 'idle' | 'deleted' | 'backfill-gone';

/** Upper bound on the closed-but-watched set, keeping memory flat. */
const MAX_REMEMBERED_CLOSED = 64;
const CLOSE_RETRY_MS = 1_000;
const MAX_CLOSE_ATTEMPTS = 4;

export class PaneLifecycle {
  /** The in-process uniqueness store (FR-6), keyed by child session id. */
  private readonly panes = new Map<string, PaneRecord>();
  /** Children whose spawn is in flight; the dedup marker for FR-6. */
  private readonly spawnsInFlight = new Set<string>();
  /** Bounded tombstones: a deleted session must never spawn or rebuild. */
  private readonly deletedSessions = new Set<string>();
  /** Idle edges observed while the child's spawn is in flight. */
  private readonly idleWhileSpawning = new Set<string>();
  /** Pending `delay()` resolvers, released early by `dispose()`. */
  private readonly pendingDelays = new Set<() => void>();
  /** Children that turned busy while their close was in flight. */
  private readonly busyWhileClosing = new Set<string>();
  /** Idle/retry timers; `provisional` marks one armed from a snapshot. */
  private readonly idleTimers = new Map<
    string,
    { handle: ClockTimerHandle; provisional: boolean }
  >();
  private readonly closeAttempts = new Map<string, number>();
  /**
   * Children this client closed on stable idle (not terminal deletion), kept
   * so a later busy event can rebuild them (FR-11). The entry carries the
   * subagent type observed at creation so the rebuild produces the same
   * display name as the first spawn.
   */
  private readonly closedWatch = new Map<
    string,
    {
      parentSessionId: string;
      directory: string;
      subagentType?: string;
      historical: boolean;
    }
  >();
  /**
   * Activity epoch per child, bumped by every held-pane event. A close
   * decision captures the epoch before its final status read and aborts when
   * the epoch moved while the read was in flight, so a stale idle snapshot
   * can never close a pane whose child just woke up.
   */
  private readonly activityEpoch = new Map<string, number>();
  private displayedSessionId: string | null;
  private displayedDirectory: string;
  /** Set by `dispose()`: no pane is registered after this point. */
  private disposed = false;

  constructor(
    private readonly ports: ClientPorts,
    private readonly config: PaneLifecycleConfig,
    private readonly logger: DiagnosticLogger = PLUGIN_LOG_SINK,
  ) {
    this.displayedSessionId = config.displayedSessionId;
    this.displayedDirectory = config.directory;
  }

  /** Updates FR-3 condition ② when the client switches displayed sessions. */
  setDisplayedSession(sessionId: string | null): void {
    this.displayedSessionId = sessionId;
  }

  setDisplayedDirectory(directory: string): void {
    this.displayedDirectory = directory;
  }

  /** Marks activity for a held child, invalidating in-flight close checks. */
  private bumpActivity(childSessionId: string): void {
    this.activityEpoch.set(
      childSessionId,
      (this.activityEpoch.get(childSessionId) ?? 0) + 1,
    );
  }

  /**
   * Stops the lifecycle. Tracked panes are closed best-effort and a spawn
   * already in flight closes its pane as soon as it completes instead of
   * registering it, so disposal can never leave a late pane behind.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.idleTimers.values()) {
      this.ports.clock.clearTimeout(timer.handle);
    }
    this.idleTimers.clear();
    this.closeAttempts.clear();
    // Release readiness retry delays: the wiring clears its tracked clock on
    // dispose, so a suspended spawn would otherwise never settle.
    for (const settle of [...this.pendingDelays]) settle();
    this.pendingDelays.clear();
    const records = [...this.panes.values()];
    this.panes.clear();
    await Promise.allSettled(
      records.map(async (record) => {
        try {
          const adapter = this.ports.adapterFactory.create(record.adapter);
          if (await adapter?.closePane(record.paneId))
            logPaneClosed(this.logger, record, 'dispose');
        } catch {
          // Fail-soft: a leftover pane is handled by the FR-8 sweep.
        }
      }),
    );
  }

  /** The client-local pane for a child session, if one is tracked. */
  getPane(childSessionId: string): PaneRecord | undefined {
    return this.panes.get(childSessionId);
  }

  directoryOf(childSessionId: string): string | undefined {
    return (
      this.panes.get(childSessionId)?.directory ??
      this.closedWatch.get(childSessionId)?.directory
    );
  }

  private rememberDeleted(childSessionId: string): void {
    this.deletedSessions.add(childSessionId);
    if (this.deletedSessions.size <= MAX_REMEMBERED_CLOSED) return;
    // Keep a deletion pinned until its in-flight spawn has checked it.
    for (const candidate of this.deletedSessions) {
      if (this.spawnsInFlight.has(candidate)) continue;
      this.deletedSessions.delete(candidate);
      break;
    }
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
    const watched = this.closedWatch.get(event.sessionId);
    if (
      !this.isOurDirectory(event, watched?.directory ?? this.displayedDirectory)
    )
      return;

    // Remember an idle consumed before the pane exists.
    if (
      this.spawnsInFlight.has(event.sessionId) &&
      (event.kind === 'idle' ||
        (event.kind === 'status' && event.status === 'idle'))
    ) {
      this.idleWhileSpawning.add(event.sessionId);
    }

    if (event.kind === 'deleted') {
      this.rememberDeleted(event.sessionId);
      // Terminal: a deleted child is never rebuilt (FR-10/FR-11).
      this.closedWatch.delete(event.sessionId);
      return;
    }

    if (this.deletedSessions.has(event.sessionId)) return;

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

    await this.createPane(
      event.sessionId,
      event.parentSessionId,
      event.subagentType,
      event.directory,
    );
  }

  /**
   * Reconciles local pane state with the server after the event stream
   * reconnects (FR-7). The server session list is authoritative for the
   * displayed parent; the same eligibility and dedup guards as the event path
   * apply, so compensation can never produce a second pane (FR-6).
   */
  async onReconnect(): Promise<void> {
    const parentSessionId = this.displayedSessionId;
    const directory = this.displayedDirectory;
    if (this.config.adapter === null) return;
    await this.reconcileOtherHeldPanes(parentSessionId, directory);
    if (
      parentSessionId === null ||
      !this.isDisplayed(parentSessionId, directory)
    )
      return;
    const heldAtStart = new Set(this.panes.keys());

    const list = await this.listSessions(directory, parentSessionId);
    if (list.error) return; // unverifiable: keep local state (fail-closed)
    // The route can move while the read is in flight; acting on the previous
    // parent would backfill panes for a conversation the user already left.
    if (!this.isDisplayed(parentSessionId, directory)) return;
    const read = await this.readStatus(directory);
    if (!this.isDisplayed(parentSessionId, directory)) return;
    const statuses = read.error ? null : read.statuses;
    const serverChildIds = new Set<string>();
    const serverAgents = new Map<string, string>();
    for (const entry of list.sessions) {
      serverChildIds.add(entry.sessionId);
      if (entry.subagentType !== undefined) {
        serverAgents.set(entry.sessionId, entry.subagentType);
      }
    }

    // Local panes whose child is gone from the server are terminal: close.
    // Only records belonging to the parent being reconciled are judged here:
    // a pane for a previously displayed session stays tracked (FR-3) and must
    // not be closed just because this parent's child list does not name it.
    for (const [childSessionId, record] of [...this.panes]) {
      if (
        record.parentSessionId !== parentSessionId ||
        record.directory !== directory
      )
        continue;
      if (!heldAtStart.has(childSessionId)) continue;
      if (!serverChildIds.has(childSessionId)) {
        await this.closePane(childSessionId, record, 'backfill-gone');
      }
    }

    // Revalidate quiescent held panes provisionally: their idle edge may be
    // lost, but a busy/retry snapshot must not arm a new deadline.
    for (const childSessionId of serverChildIds) {
      const record = this.panes.get(childSessionId);
      if (!record) continue;
      const live = statuses?.get(childSessionId);
      if (statuses && live !== 'busy' && live !== 'retry')
        this.scheduleStableIdleClose(childSessionId, record, true);
    }

    // Closed-but-watched children: drop the ones the server no longer has,
    // and rebuild the ones that turned active (busy or retry) while the
    // stream was down (their event was lost, so it is recovered from the
    // live status map).
    if (this.closedWatch.size > 0) {
      for (const [childSessionId, watched] of [...this.closedWatch]) {
        // Foreign-parent watches are not judged here: their child cannot
        // appear in this parent's list, and deleting them would permanently
        // lose the FR-11 rebuild (same rule as the removal pass above).
        if (
          watched.parentSessionId !== parentSessionId ||
          watched.directory !== directory
        )
          continue;
        if (!serverChildIds.has(childSessionId)) {
          this.closedWatch.delete(childSessionId);
          continue;
        }
        const live = statuses?.get(childSessionId);
        if (live !== 'busy' && live !== 'retry') continue;
        if (!this.isDisplayed(parentSessionId, directory)) break;
        await this.createPane(
          childSessionId,
          watched.parentSessionId,
          watched.subagentType,
          watched.directory,
          live,
        );
      }
    }

    // Backfill children the server has but this client does not track.
    for (const childSessionId of serverChildIds) {
      if (this.panes.has(childSessionId)) continue;
      if (this.closedWatch.has(childSessionId)) continue;
      const live = statuses?.get(childSessionId);
      if (live !== 'busy' && live !== 'retry') {
        if (statuses)
          this.rememberClosed(
            childSessionId,
            parentSessionId,
            directory,
            serverAgents.get(childSessionId),
            true,
          );
        continue;
      }
      if (!this.isDisplayed(parentSessionId, directory)) break;
      await this.createPane(
        childSessionId,
        parentSessionId,
        serverAgents.get(childSessionId),
        directory,
        live,
      );
    }
  }

  /** Recheck held panes without backfilling conversations that are not visible. */
  private async reconcileOtherHeldPanes(
    parent: string | null,
    directory: string,
  ): Promise<void> {
    const groups = new Map<
      string,
      { records: Array<{ record: PaneRecord; epoch: number }> }
    >();
    for (const record of this.panes.values()) {
      if (record.parentSessionId === parent && record.directory === directory)
        continue;
      const key = JSON.stringify([record.directory, record.parentSessionId]);
      const group = groups.get(key) ?? { records: [] };
      group.records.push({
        record,
        epoch: this.activityEpoch.get(record.childSessionId) ?? 0,
      });
      groups.set(key, group);
    }
    for (const { records } of groups.values()) {
      const first = records[0]?.record;
      if (!first || this.disposed) continue;
      const list = await this.listSessions(
        first.directory,
        first.parentSessionId,
      );
      if (list.error) continue;
      const statuses = await this.readStatus(first.directory);
      const children = new Set(list.sessions.map((entry) => entry.sessionId));
      for (const { record, epoch } of records) {
        const id = record.childSessionId;
        if (
          this.disposed ||
          this.panes.get(id) !== record ||
          (this.activityEpoch.get(id) ?? 0) !== epoch
        )
          continue;
        if (!children.has(id))
          await this.closePane(id, record, 'backfill-gone');
        else if (
          !statuses.error &&
          statuses.statuses.get(id) !== 'busy' &&
          statuses.statuses.get(id) !== 'retry'
        )
          this.scheduleStableIdleClose(id, record, true);
      }
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
    if (!this.isOurDirectory(event, record.directory)) return;

    if (event.kind === 'deleted') {
      this.rememberDeleted(event.sessionId);
      this.bumpActivity(event.sessionId);
      this.closeAttempts.delete(event.sessionId);
      await this.closePane(event.sessionId, record, 'deleted');
      return;
    }
    if (this.deletedSessions.has(event.sessionId)) return;
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
      // A close already in flight consumed this edge; remember it so the pane
      // is rebuilt as soon as the close settles (FR-11).
      if (record.status === 'closing') {
        this.busyWhileClosing.add(event.sessionId);
      }
    }
  }

  /**
   * FR-11: a child this client closed on stable idle that turns active again
   * (busy or retry) is rebuilt, but only while its parent is still the
   * displayed session. The rebuild goes through the normal creation path, so
   * the anchor is re-resolved rather than replayed from memory.
   */
  private async handleClosedChildBusy(
    event: SessionLifecycleEvent,
  ): Promise<void> {
    if (event.status !== 'busy' && event.status !== 'retry') return;
    const watched = this.closedWatch.get(event.sessionId);
    if (watched === undefined) return;

    await this.rebuildWatched(
      event.sessionId,
      watched.parentSessionId,
      watched.directory,
      watched.subagentType,
    );
  }

  private async rebuildWatched(
    childSessionId: string,
    parentSessionId: string,
    directory: string,
    subagentType?: string,
  ): Promise<void> {
    if (parentSessionId !== this.displayedSessionId) return;
    if (this.config.adapter === null) return;

    await this.createPane(
      childSessionId,
      parentSessionId,
      subagentType,
      directory,
    );
  }

  private isOurDirectory(
    event: SessionLifecycleEvent,
    directory: string,
  ): boolean {
    return event.directory === directory;
  }

  private isDisplayed(parentSessionId: string, directory: string): boolean {
    return (
      this.displayedSessionId === parentSessionId &&
      this.displayedDirectory === directory
    );
  }

  private async createPane(
    childSessionId: string,
    parentSessionId: string,
    subagentType?: string,
    directory = this.displayedDirectory,
    knownStatus?: SessionRuntimeStatus,
  ): Promise<void> {
    const adapterType = this.config.adapter;
    if (adapterType === null) return;
    // Every creation path shares this in-process FR-6 dedup gate.
    if (
      this.panes.has(childSessionId) ||
      this.spawnsInFlight.has(childSessionId) ||
      this.deletedSessions.has(childSessionId)
    )
      return;

    // Creation supersedes any pending rebuild watch for this child; the watch
    // is dropped only once the pane exists, so a failed attempt (readiness
    // timeout, adapter failure) stays eligible for a later busy edge.
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

      const readyStatus =
        knownStatus ?? (await this.waitForReady(directory, childSessionId));
      if (readyStatus === null) {
        logNoPane(this.logger, 'readiness-timeout', {
          childSessionId,
          parentSessionId,
          adapter: adapterType,
        });
        return;
      }

      // The client may have been disposed while readiness was pending.
      if (this.disposed) return;

      // Deleted while waiting for readiness: never create the pane (FR-10).
      if (this.deletedSessions.has(childSessionId)) return;

      const result = await this.spawn(
        adapter,
        childSessionId,
        parentSessionId,
        serverUrl.url,
        directory,
        subagentType,
      );
      if (!result.success || !result.paneId) {
        logNoPane(this.logger, this.adapterFailureReason(result.error), {
          childSessionId,
          parentSessionId,
          adapter: adapterType,
        });
        return;
      }

      // Disposed during the spawn: close the pane immediately instead of
      // registering it, so disposal cannot leak a late pane.
      if (this.disposed) {
        try {
          if (await adapter.closePane(result.paneId)) {
            logPaneClosed(
              this.logger,
              {
                childSessionId,
                parentSessionId,
                paneId: result.paneId,
                adapter: adapterType,
                anchoredTarget: this.resolveAnchoredTarget(),
              },
              'dispose',
            );
          }
        } catch {
          // Fail-soft: the FR-8 sweep is the documented fallback.
        }
        return;
      }

      const record: PaneRecord = {
        childSessionId,
        parentSessionId,
        directory,
        paneId: result.paneId,
        adapter: adapterType,
        anchoredTarget: this.resolveAnchoredTarget(),
        status: 'active',
        ...(subagentType === undefined ? {} : { subagentType }),
      };
      this.panes.set(childSessionId, record);
      this.closedWatch.delete(childSessionId);
      this.ports.onChildTracked?.(childSessionId, directory);
      logPaneCreated(this.logger, record);

      // Deleted during the spawn itself: register, then close right away.
      if (this.deletedSessions.has(childSessionId)) {
        await this.closePane(childSessionId, record, 'deleted');
        return;
      }

      // A snapshot or an idle observed before registration is provisional;
      // the first real idle edge after registration starts its own window.
      const idleDuringSpawn = this.idleWhileSpawning.has(childSessionId);
      if (
        knownStatus !== undefined ||
        readyStatus === 'idle' ||
        idleDuringSpawn
      ) {
        this.scheduleStableIdleClose(childSessionId, record, true);
      }

      await this.applyLayout(adapter);
    } finally {
      this.spawnsInFlight.delete(childSessionId);
      if (
        !this.disposed &&
        !this.deletedSessions.has(childSessionId) &&
        !this.panes.has(childSessionId)
      ) {
        this.rememberClosed(
          childSessionId,
          parentSessionId,
          directory,
          subagentType,
        );
      }
      this.idleWhileSpawning.delete(childSessionId);
    }
  }

  private async spawn(
    adapter: Multiplexer,
    childSessionId: string,
    parentSessionId: string,
    serverUrl: string,
    directory: string,
    subagentType?: string,
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
        directory,
        {
          parentSessionId,
          subagentType,
          ...this.config.viewer,
        },
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
      if (this.disposed) return null;
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
      return { sessions: [], error: 'session list read failed' };
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
      const settle = (): void => {
        this.pendingDelays.delete(settle);
        resolve();
      };
      this.pendingDelays.add(settle);
      this.ports.clock.setTimeout(settle, milliseconds);
    });
  }

  private scheduleStableIdleClose(
    childSessionId: string,
    record: PaneRecord,
    provisional = false,
  ): void {
    if (record.status !== 'active') return;
    // Only the first real idle edge restarts a provisional deadline.
    const pending = this.idleTimers.get(childSessionId);
    if (pending) {
      if (provisional || !pending.provisional) return;
      this.cancelIdleClose(childSessionId, false);
    }

    const handle = this.ports.clock.setTimeout(() => {
      this.idleTimers.delete(childSessionId);
      void this.closeIfStillIdle(childSessionId, provisional);
    }, this.config.stableIdleMs);
    this.idleTimers.set(childSessionId, { handle, provisional });
  }

  private cancelIdleClose(childSessionId: string, resetAttempts = true): void {
    if (resetAttempts) this.closeAttempts.delete(childSessionId);
    const pending = this.idleTimers.get(childSessionId);
    if (pending === undefined) return;
    this.idleTimers.delete(childSessionId);
    this.ports.clock.clearTimeout(pending.handle);
  }

  private async closeIfStillIdle(
    childSessionId: string,
    provisional = false,
  ): Promise<void> {
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
    const read = await this.readStatus(record.directory);
    if (read.error) {
      if ((this.activityEpoch.get(childSessionId) ?? 0) === epoch) {
        this.scheduleCloseRetry(childSessionId, record, 'idle', provisional);
      }
      return;
    }
    // Any held-pane event while the read was in flight (a busy/retry edge, a
    // fresh idle, a deletion) invalidates the decision: the snapshot may
    // predate it, and that event has already been consumed.
    if ((this.activityEpoch.get(childSessionId) ?? 0) !== epoch) return;
    if (this.panes.get(childSessionId)?.status !== 'active') return;
    const status = read.statuses.get(childSessionId);
    if (status === 'busy' || status === 'retry') {
      this.closeAttempts.delete(childSessionId);
      return;
    }

    await this.closePane(childSessionId, record, 'idle', provisional);
  }

  private async closePane(
    childSessionId: string,
    record: PaneRecord,
    reason: PaneCloseReason,
    provisional = false,
  ): Promise<void> {
    if (record.status === 'closing') return;
    record.status = 'closing';
    this.cancelIdleClose(childSessionId, false);

    let closed = false;
    try {
      const adapter = this.ports.adapterFactory.create(record.adapter);
      closed = (await adapter?.closePane(record.paneId)) === true;
    } catch {
      closed = false;
    }

    if (closed) {
      logPaneClosed(
        this.logger,
        record,
        reason === 'idle' ? 'stable-idle' : reason,
      );
      this.panes.delete(childSessionId);
      this.activityEpoch.delete(childSessionId);
      this.closeAttempts.delete(childSessionId);
      const wasBusy = this.busyWhileClosing.delete(childSessionId);
      // Only idle closes are rebuildable; deleted/gone children are terminal.
      if (reason === 'idle') {
        this.rememberClosed(
          childSessionId,
          record.parentSessionId,
          record.directory,
          record.subagentType,
        );
        // The child turned busy while this close was in flight; that edge was
        // consumed by the close, so rebuild right away instead of waiting for
        // the next event or the reconcile tick.
        if (wasBusy) {
          await this.rebuildWatched(
            childSessionId,
            record.parentSessionId,
            record.directory,
            record.subagentType,
          );
        }
      }
      return;
    }
    // Close failed: keep tracking so a later event can retry; dropping the
    // record while the pane may still exist would break FR-6 uniqueness.
    record.status = 'active';
    const wasBusy = this.busyWhileClosing.delete(childSessionId);
    if (!wasBusy || reason !== 'idle')
      this.scheduleCloseRetry(childSessionId, record, reason, provisional);
  }

  private scheduleCloseRetry(
    childSessionId: string,
    record: PaneRecord,
    reason: PaneCloseReason,
    provisional = false,
  ): void {
    if (this.disposed || this.panes.get(childSessionId) !== record) return;
    const attempts = (this.closeAttempts.get(childSessionId) ?? 0) + 1;
    this.closeAttempts.set(childSessionId, attempts);
    if (attempts >= MAX_CLOSE_ATTEMPTS) {
      this.logger.log('[multiplexer] pane close retries exhausted', {
        event: 'multiplexer.pane-close-failed',
        ...record,
        reason: 'retries-exhausted',
        closeReason: reason,
      });
      return;
    }
    const handle = this.ports.clock.setTimeout(() => {
      this.idleTimers.delete(childSessionId);
      if (this.panes.get(childSessionId) !== record) return;
      void (reason === 'idle'
        ? this.closeIfStillIdle(childSessionId, provisional)
        : this.closePane(childSessionId, record, reason));
    }, CLOSE_RETRY_MS);
    this.idleTimers.set(childSessionId, { handle, provisional });
  }

  /** Remembers an idle-closed child for FR-11 rebuilds, bounded in size. */
  private rememberClosed(
    childSessionId: string,
    parentSessionId: string,
    directory: string,
    subagentType?: string,
    historical = false,
  ): void {
    this.closedWatch.delete(childSessionId);
    this.closedWatch.set(childSessionId, {
      parentSessionId,
      directory,
      subagentType,
      historical,
    });
    this.ports.onChildTracked?.(childSessionId, directory);
    if (this.closedWatch.size <= MAX_REMEMBERED_CLOSED) return;
    const oldest =
      [...this.closedWatch].find(([, watch]) => watch.historical)?.[0] ??
      this.closedWatch.keys().next().value;
    if (oldest !== undefined) this.closedWatch.delete(oldest);
  }
}
