import { POLL_INTERVAL_BACKGROUND_MS } from '../../config';
import { log } from '../../utils/logger';
import type { Multiplexer } from '../types';
import { isServerRunning } from '../types';
import { CmuxClosePolicy, type CmuxCloseReason } from './close-policy';
import { type CmuxSessionRecord, CmuxSessionStore } from './session-state';

export interface CmuxSessionEvent {
  type: string;
  properties?: CmuxSessionEventPayload;
  /** Live v2 hosts key the payload under `data`. */
  data?: CmuxSessionEventPayload;
}

interface CmuxSessionEventPayload {
  info?: {
    id?: string;
    parentID?: string;
    title?: string;
    directory?: string;
    sessionID?: string;
  };
  part?: { sessionID?: string };
  sessionID?: string;
  status?: { type: string };
}

interface BackgroundJobs {
  deferIfRunning(session: string): boolean;
  clearDeferredClose(session: string): void;
}

export interface CmuxSessionLifecycleOptions {
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  deferredRetryMs?: number;
  deferredTtlMs?: number;
  /** @deprecated Missing status never establishes deletion. */
  missingGraceMs?: number;
  closeRetryMs?: number;
  closeRetryTtlMs?: number;
  closeRetryMaxAttempts?: number;
  orphanCooldownMs?: number;
  shutdownTimeoutMs?: number;
  isServerRunning?: (url: string) => Promise<boolean>;
  fetchStatuses?: () => Promise<Record<string, { type: string }>>;
  permanentlyClosedSessions?: Set<string>;
}

const ACTIVITY_EVENTS = new Set([
  'message.updated',
  'message.removed',
  'message.part.updated',
  'message.part.delta',
  'message.part.removed',
  'session.next.text.delta',
  'session.next.reasoning.delta',
]);
const MIN_LIFETIME_MS = 10_000;
const IDLE_CONFIRMATIONS = 3;

function normalizeServerUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

class ServerUrlUnavailableError extends Error {
  constructor() {
    super('OpenCode server URL is unavailable');
    this.name = 'ServerUrlUnavailableError';
  }
}

export class CmuxSessionLifecycle {
  private readonly store = new CmuxSessionStore();
  private readonly policy: CmuxClosePolicy;
  private readonly now: () => number;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly injectedDelay: boolean;
  private readonly deferredRetryMs: number;
  private readonly deferredTtlMs: number;
  private readonly closeRetryMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly serverCheck: (url: string) => Promise<boolean>;
  private readonly fetchStatuses: () => Promise<
    Record<string, { type: string }>
  >;
  private pollTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private cleanupPromise?: Promise<void>;
  private disposed = false;
  private spawnGeneration = 0;
  private readonly ownerGeneration: number;
  private readonly permanentlyClosedSessions?: Set<string>;
  private readonly serverScope: () => string | undefined;
  private readonly removeLatePaneObserver: () => void;
  private initialOrphansRecovered = false;

  constructor(
    private readonly owner: string,
    private readonly multiplexer: Multiplexer,
    private readonly resolveServerUrl: () => string | null,
    private readonly defaultDirectory: string,
    private readonly backgroundJobs?: BackgroundJobs,
    options: CmuxSessionLifecycleOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.permanentlyClosedSessions = options.permanentlyClosedSessions;
    this.injectedDelay = Boolean(options.delay);
    this.delay =
      options.delay ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.deferredRetryMs = options.deferredRetryMs ?? 2_000;
    this.deferredTtlMs = options.deferredTtlMs ?? 300_000;
    this.closeRetryMs = options.closeRetryMs ?? 1_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    this.policy = new CmuxClosePolicy(
      options.closeRetryTtlMs,
      options.closeRetryMaxAttempts,
    );
    this.serverCheck = options.isServerRunning ?? isServerRunning;
    this.fetchStatuses = options.fetchStatuses ?? (() => this.loadStatuses());
    this.ownerGeneration = this.store.registerOwner();
    this.serverScope = () => normalizeServerUrl(this.resolveServerUrl());
    this.removeLatePaneObserver = this.store.observeLatePaneOrphans(
      defaultDirectory,
      this.serverScope,
      (record) => this.claimLatePaneOrphans(record),
      this.ownerGeneration,
    );
  }

  async onSessionCreated(event: CmuxSessionEvent): Promise<void> {
    if (this.disposed) return;
    if (event.type !== 'session.created') return;
    this.claimLatePaneOrphans();
    const info = event.properties?.info;
    if (!info?.id || !info.parentID) return;
    if (this.permanentlyClosedSessions?.has(info.id)) return;
    const now = this.now();
    const record: CmuxSessionRecord = {
      session: info.id,
      owner: this.owner,
      ownerGeneration: this.ownerGeneration,
      parent: info.parentID,
      title: info.title ?? 'Subagent',
      directory: info.directory ?? this.defaultDirectory,
      serverUrl: normalizeServerUrl(this.resolveServerUrl()),
      spawnState: 'known',
      lifecycle: 'active',
      lastActivityAt: now,
      activityVersion: 0,
      idleConsecutive: 0,
    };
    if (!this.store.claimCreated(record)) {
      const current = this.store.get(record.session);
      if (
        current?.owner === this.owner &&
        current.paneId &&
        (current.lifecycle === 'orphaned' || current.lifecycle === 'deleted')
      )
        this.recoverOrphans([current]);
      return;
    }
    if (record.paneId && record.lifecycle !== 'active') {
      record.closeIntent = undefined;
      await this.requestClose(record, 'cleanup');
      return;
    }
    await this.spawn(record);
  }

  async onSessionStatus(event: CmuxSessionEvent): Promise<void> {
    if (this.disposed) return;
    const isActivity = ACTIVITY_EVENTS.has(event.type);
    // Token-stream deltas fire per chunk. Claiming orphans is for
    // lifecycle transitions, not the heartbeat path.
    if (!isActivity) this.claimLatePaneOrphans();
    const session = this.eventSession(event);
    if (!session) return;
    const owned = this.store.get(session);
    if (!owned || owned.owner !== this.owner) return;
    if (isActivity) {
      this.activity(session);
      return;
    }
    const status =
      event.type === 'session.idle'
        ? 'idle'
        : event.type === 'session.status'
          ? event.properties?.status?.type
          : undefined;
    if (!status) return;
    if (status !== 'idle') {
      const record = this.store.get(session);
      if (status === 'busy' && record) this.reactivateOrphan(record);
      this.activity(session);
      this.backgroundJobs?.clearDeferredClose(session);
      const current = this.store.get(session);
      if (
        status === 'busy' &&
        current &&
        current.lifecycle === 'active' &&
        !current.paneId
      )
        await this.spawn(current);
    }
    if (owned.paneId) this.startPolling();
  }

  async onSessionDeleted(event: CmuxSessionEvent): Promise<void> {
    if (event.type !== 'session.deleted') return;
    if (this.disposed) return;
    this.claimLatePaneOrphans();
    const session = this.eventSession(event);
    if (!session) return;
    const record = this.store.get(session);
    if (!record) return;
    if (record.owner !== this.owner) return;
    this.store.markDeleted(session);
    this.cancelDeferred(record);
    this.backgroundJobs?.clearDeferredClose(session);
    if (!record.paneId) {
      if (!record.spawnPromise) this.store.removeWithoutPane(session);
      return;
    }
    await this.requestClose(record, 'deleted');
  }

  async closeSessionFromCoordinator(session: string): Promise<void> {
    if (this.disposed) return;
    this.claimLatePaneOrphans();
    const record = this.store.get(session);
    if (record?.paneId && record.owner === this.owner) {
      // This is independent terminal evidence. It may permit an absent map
      // entry, while a bare absent status remains non-terminal.
      record.terminalConfirmed = true;
      this.startPolling();
    }
  }

  async closeSessionPermanentlyFromCoordinator(session: string): Promise<void> {
    if (this.disposed) return;
    this.claimLatePaneOrphans();
    this.permanentlyClosedSessions?.add(session);
    const record = this.store.get(session);
    if (!record || record.owner !== this.owner) return;
    record.lifecycle = 'deleted';
    this.cancelDeferred(record);
    this.backgroundJobs?.clearDeferredClose(session);
    if (!record.paneId) {
      if (!record.spawnPromise) this.store.removeWithoutPane(session);
      return;
    }
    await this.requestClose(record, 'deleted');
  }

  cleanup(): Promise<void> {
    this.cleanupPromise ??= this.runCleanup();
    return this.cleanupPromise;
  }

  /** Runs one status pass; exposed for deterministic lifecycle tests. */
  pollOnce(): Promise<void> {
    return this.poll();
  }

  private async spawn(
    record: CmuxSessionRecord,
    deferred = false,
  ): Promise<void> {
    if (
      this.disposed ||
      record.owner !== this.owner ||
      record.lifecycle !== 'active' ||
      this.permanentlyClosedSessions?.has(record.session)
    )
      return;
    if (record.spawnState === 'spawning' || record.paneId) return;
    const generation = this.spawnGeneration;
    const token = record.deferredSpawn?.generation;
    record.spawnState = 'spawning';
    const operation = this.spawnOperation(record);
    record.spawnPromise = operation;
    const result = await operation;
    if (record.spawnPromise === operation) record.spawnPromise = undefined;
    const current = this.store.get(record.session);
    const recordChanged = current && current !== record;
    const ownerChanged = current && current.owner !== this.owner;
    if (
      this.disposed ||
      generation !== this.spawnGeneration ||
      this.permanentlyClosedSessions?.has(record.session) ||
      recordChanged ||
      ownerChanged
    ) {
      const latePane = result.paneId ?? result.orphanPaneId;
      if (latePane) await this.closeLatePane(record, latePane);
      if (current === record && current.owner === this.owner && !current.paneId)
        this.store.removeWithoutPane(record.session);
      return;
    }
    if (!current) {
      if (result.success && result.paneId)
        await this.adoptAndClose(record, result.paneId);
      if (result.orphanPaneId)
        await this.adoptAndClose(record, result.orphanPaneId);
      return;
    }
    if (
      deferred &&
      token !== undefined &&
      current.deferredSpawn?.generation !== token
    ) {
      const stalePane = result.paneId ?? result.orphanPaneId;
      if (stalePane) await this.adoptAndClose(current, stalePane);
      return;
    }
    const paneId = result.paneId ?? result.orphanPaneId;
    if (paneId) {
      this.store.markAttached(record.session, paneId, this.now());
      if (result.orphanPaneId) this.store.markOrphaned(record.session);
      if (current.lifecycle !== 'active' || result.orphanPaneId) {
        await this.requestClose(
          current,
          current.lifecycle === 'active' ? 'cleanup' : 'deleted',
        );
      } else this.startPolling();
      return;
    }
    current.spawnState = 'failed';
    if (current.lifecycle !== 'active') {
      this.store.removeWithoutPane(current.session);
    } else if (
      result.error === 'unavailable' ||
      result.error === 'not_found' ||
      result.error === 'invalid_state'
    ) {
      this.deferSpawn(current);
    }
  }

  private async spawnOperation(record: CmuxSessionRecord) {
    const serverUrl = this.resolveServerUrl();
    if (!serverUrl) {
      log('[cmux-session-lifecycle] no valid server URL; skipping spawn');
      return { success: false, error: 'unavailable' as const };
    }
    record.serverUrl = normalizeServerUrl(serverUrl);
    if (!(await this.serverCheck(serverUrl)))
      return { success: false, error: 'unavailable' as const };
    if (this.permanentlyClosedSessions?.has(record.session))
      return { success: false, error: 'unavailable' as const };
    try {
      return await this.multiplexer.spawnPane(
        record.session,
        record.title,
        serverUrl,
        record.directory,
      );
    } catch {
      return { success: false, error: 'hard' as const };
    }
  }

  private deferSpawn(record: CmuxSessionRecord): void {
    if (this.disposed || record.owner !== this.owner) return;
    const existing = record.deferredSpawn;
    const deferred = existing ?? {
      deadline: this.now() + this.deferredTtlMs,
      generation: 0,
    };
    deferred.generation += 1;
    deferred.timer?.cancel();
    record.deferredSpawn = deferred;
    if (this.now() >= deferred.deadline) {
      this.cancelDeferred(record);
      return;
    }
    deferred.timer = this.timer(async () => {
      deferred.timer = undefined;
      if (
        this.disposed ||
        this.store.get(record.session) !== record ||
        record.lifecycle !== 'active' ||
        record.owner !== this.owner ||
        this.permanentlyClosedSessions?.has(record.session)
      )
        return;
      await this.spawn(record, true);
    }, this.deferredRetryMs);
  }

  private cancelDeferred(record: CmuxSessionRecord): void {
    record.deferredSpawn?.timer?.cancel();
    record.deferredSpawn = undefined;
  }

  private reactivateOrphan(record: CmuxSessionRecord): void {
    if (
      this.disposed ||
      this.store.get(record.session) !== record ||
      record.owner !== this.owner ||
      record.lifecycle !== 'orphaned' ||
      record.closePromise
    )
      return;
    record.closeTimer?.cancel();
    record.closeTimer = undefined;
    record.closeIntent = undefined;
    record.lifecycle = 'active';
    record.idleConsecutive = 0;
    record.statusMissingSince = undefined;
    record.terminalConfirmed = false;
  }

  private activity(session: string): void {
    const record = this.store.get(session);
    if (!record || record.owner !== this.owner || this.disposed) return;
    if (record.closePromise) {
      this.store.markActivity(session, this.now());
      record.terminalConfirmed = false;
      return;
    }
    this.store.markActivity(session, this.now());
    record.terminalConfirmed = false;
    const next = this.policy.activity(record.closeIntent);
    if (!next && record.closeIntent) record.closeTimer?.cancel();
    record.closeIntent = next;
    if (!next) record.closeTimer = undefined;
  }

  private async requestClose(
    record: CmuxSessionRecord,
    reason: CmuxCloseReason,
  ): Promise<void> {
    if (
      !record.paneId ||
      record.owner !== this.owner ||
      this.store.get(record.session) !== record
    )
      return;
    if (
      reason === 'idle' &&
      !(this.backgroundJobs?.deferIfRunning(record.session) ?? true)
    )
      return;
    if (record.closePromise) {
      await record.closePromise;
      return;
    }
    const previous = record.closeIntent;
    record.closeIntent = this.policy.request(
      reason,
      record.activityVersion,
      this.now(),
      previous,
    );
    if (previous !== record.closeIntent) record.closeTimer?.cancel();
    await this.attemptClose(record);
  }

  private async attemptClose(record: CmuxSessionRecord): Promise<void> {
    if (record.closePromise) {
      await record.closePromise;
      if (record.paneId && record.closeIntent) await this.attemptClose(record);
      return;
    }
    const operation = this.performClose(record);
    const trackedOperation = operation.finally(() => {
      if (record.closePromise === trackedOperation) {
        record.closePromise = undefined;
        this.store.notifyLatePaneOrphan(record);
      }
    });
    record.closePromise = trackedOperation;
    await trackedOperation;
  }

  private async performClose(record: CmuxSessionRecord): Promise<void> {
    const intent = record.closeIntent;
    if (
      !intent ||
      !record.paneId ||
      record.owner !== this.owner ||
      this.store.get(record.session) !== record
    )
      return;
    if (intent.phase === 'cooldown' && this.now() < intent.nextAttemptAt) {
      this.scheduleCooldown(record);
      return;
    }
    record.closeIntent = this.policy.resume(intent, this.now());
    if (record.closeIntent !== intent) return this.performClose(record);
    if (
      intent.reason === 'idle' &&
      intent.expectedActivityVersion !== record.activityVersion
    ) {
      record.closeIntent = this.policy.activity(intent);
      return;
    }
    const paneId = record.paneId;
    let closed = false;
    try {
      // Await completion before any retry so the pane ID is never reused while
      // an older adapter kill may still be running.
      closed = await this.multiplexer.closePane(paneId);
    } catch (error) {
      log('[cmux-session-lifecycle] closePane failed; retaining pane', {
        owner: this.owner,
        session: record.session,
        paneId,
        error: String(error),
      });
    }
    const current = this.store.get(record.session);
    const ownerChanged =
      current === record &&
      record.owner !== this.owner &&
      record.paneId === paneId;
    if (ownerChanged) record.closeSettlement = { paneId, closed };
    else record.closeSettlement = undefined;
    const intentStillCurrent = record.closeIntent === intent;
    const idleStillCurrent =
      intent.reason !== 'idle' ||
      intent.expectedActivityVersion === record.activityVersion;
    if (
      current !== record ||
      record.owner !== this.owner ||
      record.paneId !== paneId
    )
      return;
    if (!intentStillCurrent || !idleStillCurrent) {
      if (closed) await this.settleClosedPane(record, paneId);
      return;
    }
    if (closed) {
      if (this.disposed) {
        await this.settleClosedPane(record, paneId);
        return;
      }
      record.closeTimer?.cancel();
      record.closeTimer = undefined;
      if (record.lifecycle !== 'active') {
        this.store.removeAfterConfirmedClose(record.session);
      } else {
        record.paneId = undefined;
        record.spawnState = 'known';
        if (intentStillCurrent) record.closeIntent = this.policy.complete();
        if (
          intent.reason === 'idle' &&
          record.owner === this.owner &&
          !this.disposed &&
          record.activityVersion !== intent.expectedActivityVersion
        )
          await this.spawn(record);
      }
      this.updatePolling();
      return;
    }
    if (this.disposed) {
      record.closeIntent = this.policy.failed(intent, this.now());
      if (record.closeIntent.phase === 'cooldown') {
        this.scheduleCooldown(record);
      } else {
        record.closeTimer?.cancel();
        record.closeTimer = this.timer(
          () => this.attemptClose(record),
          this.closeRetryMs,
        );
      }
      return;
    }
    record.closeIntent = this.policy.failed(intent, this.now());
    if (record.closeIntent.phase === 'cooldown') {
      if (!Number.isFinite(record.closeIntent.nextAttemptAt))
        this.store.markOrphaned(record.session);
      this.scheduleCooldown(record);
      return;
    }
    record.closeTimer?.cancel();
    record.closeTimer = this.timer(
      () => this.attemptClose(record),
      this.closeRetryMs,
    );
  }

  private async settleClosedPane(
    record: CmuxSessionRecord,
    paneId: string,
  ): Promise<void> {
    if (
      this.store.get(record.session) !== record ||
      record.owner !== this.owner ||
      record.paneId !== paneId
    )
      return;
    record.closeTimer?.cancel();
    record.closeTimer = undefined;
    record.closeIntent = undefined;
    if (record.lifecycle !== 'active' || this.disposed) {
      this.store.removeAfterConfirmedClose(record.session);
      this.updatePolling();
      return;
    }
    record.paneId = undefined;
    record.spawnState = 'known';
    this.updatePolling();
    await this.spawn(record);
  }

  private scheduleCooldown(record: CmuxSessionRecord): void {
    record.closeTimer?.cancel();
    record.closeTimer = undefined;
    const intent = record.closeIntent;
    if (!intent || !Number.isFinite(intent.nextAttemptAt) || this.disposed)
      return;
    record.closeTimer = this.timer(
      () => this.attemptClose(record),
      Math.max(0, intent.nextAttemptAt - this.now()),
    );
  }

  private async poll(): Promise<void> {
    if (this.disposed) return;
    this.claimLatePaneOrphans();
    if (this.polling) return;
    this.polling = true;
    try {
      const statuses = await this.fetchStatuses();
      for (const record of this.store.ownedBy(this.owner)) {
        if (!record.paneId || record.lifecycle !== 'active') continue;
        const status = statuses[record.session];
        if (!status) {
          record.statusMissingSince ??= this.now();
          record.idleConsecutive = 0;
          if (record.terminalConfirmed) await this.requestClose(record, 'idle');
          else
            log('[cmux-session-lifecycle] status absent; retaining pane', {
              owner: this.owner,
              session: record.session,
              paneId: record.paneId,
              missingForMs: this.now() - record.statusMissingSince,
              recovery:
                'requires-session.deleted-or-reliable-existence-evidence',
            });
          continue;
        }
        record.statusMissingSince = undefined;
        if (status.type !== 'idle') {
          this.activity(record.session);
          continue;
        }
        if (
          this.now() - (record.attachedAt ?? this.now()) < MIN_LIFETIME_MS ||
          this.now() - record.lastActivityAt < MIN_LIFETIME_MS
        ) {
          record.idleConsecutive = 0;
          continue;
        }
        record.idleConsecutive += 1;
        if (record.idleConsecutive < IDLE_CONFIRMATIONS) continue;
        const version = record.activityVersion;
        const final = await this.fetchStatuses();
        if (
          final[record.session]?.type === 'idle' &&
          version === record.activityVersion
        )
          await this.requestClose(record, 'idle');
        else if (!final[record.session] && record.terminalConfirmed)
          await this.requestClose(record, 'idle');
        else if (!final[record.session])
          log('[cmux-session-lifecycle] final status absent; retaining pane', {
            owner: this.owner,
            session: record.session,
            paneId: record.paneId,
          });
        else this.activity(record.session);
      }
    } catch {
      // A transient status endpoint failure must not reject the interval task.
    } finally {
      this.polling = false;
    }
  }

  private resumeTransferredClose(record: CmuxSessionRecord): void {
    const closePromise = record.closePromise;
    if (!closePromise) return;
    void closePromise.then(() => {
      if (
        this.disposed ||
        this.store.get(record.session) !== record ||
        record.owner !== this.owner ||
        !record.paneId
      )
        return;
      if (this.applyCloseSettlement(record)) return;
      void this.requestClose(record, 'cleanup');
    });
  }

  private applyCloseSettlement(record: CmuxSessionRecord): boolean {
    const settlement = this.store.consumeCloseSettlement(record);
    if (!settlement) return false;
    if (!settlement.closed) return false;
    if (
      record.lifecycle === 'active' &&
      !record.closeIntent &&
      !this.disposed
    ) {
      record.closeTimer?.cancel();
      record.closeTimer = undefined;
      record.paneId = undefined;
      record.spawnState = 'known';
      this.updatePolling();
      void this.spawn(record);
      return true;
    }
    this.store.removeAfterConfirmedClose(record.session);
    this.updatePolling();
    return true;
  }

  private startPolling(): void {
    if (this.pollTimer || this.disposed) return;
    this.pollTimer = setInterval(
      () => void this.poll().catch(() => undefined),
      POLL_INTERVAL_BACKGROUND_MS,
    );
    this.pollTimer.unref?.();
  }

  private updatePolling(): void {
    if (
      this.store
        .ownedBy(this.owner)
        .some((record) => record.paneId && record.lifecycle === 'active')
    )
      this.startPolling();
    else if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async waitForSettlements(
    pending: Promise<unknown>[],
    deadlineAt: number,
  ): Promise<boolean> {
    if (pending.length === 0) return true;
    const settled = Promise.allSettled(pending).then(() => true);
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      void settled;
      return false;
    }
    return new Promise<boolean>((resolve) => {
      let finished = false;
      let nativeTimer: ReturnType<typeof setTimeout> | undefined;
      let injectedTimer: { cancel(): void } | undefined;
      const finish = (completed: boolean) => {
        if (finished) return;
        finished = true;
        if (nativeTimer) clearTimeout(nativeTimer);
        injectedTimer?.cancel();
        resolve(completed);
      };

      nativeTimer = setTimeout(() => finish(false), remaining);
      nativeTimer.unref?.();
      if (this.injectedDelay)
        injectedTimer = this.timer(() => finish(false), Math.max(0, remaining));
      void settled.then(
        () => finish(true),
        () => finish(true),
      );
    });
  }

  private async runCleanup(): Promise<void> {
    const deadlineAt = Date.now() + Math.max(0, this.shutdownTimeoutMs);
    this.disposed = true;
    this.removeLatePaneObserver();
    this.spawnGeneration += 1;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    const records = this.store.ownedBy(this.owner);
    for (const record of records) this.cancelDeferred(record);
    const pending = records.flatMap((record) =>
      record.spawnPromise ? [record.spawnPromise] : [],
    );
    await this.waitForSettlements(pending, deadlineAt);
    const closeWork = this.store
      .ownedBy(this.owner)
      .map((record) => this.cleanupRecordUntil(record, deadlineAt));
    await Promise.allSettled(closeWork);
  }

  private async cleanupRecordUntil(
    record: CmuxSessionRecord,
    deadlineAt: number,
  ): Promise<void> {
    try {
      if (!record.paneId) {
        if (!record.spawnPromise) this.store.removeWithoutPane(record.session);
        return;
      }
      if (this.applyCloseSettlement(record)) return;
      record.closeTimer?.cancel();
      record.closeTimer = undefined;
      if (!record.closePromise || !record.closeIntent)
        record.closeIntent = this.policy.request(
          'cleanup',
          record.activityVersion,
          this.now(),
        );
      while (
        record.closeIntent?.phase === 'pending' &&
        this.store.get(record.session) === record &&
        record.owner === this.owner
      ) {
        const attempt = this.attemptCloseWithoutTimer(record);
        if (!(await this.waitForSettlements([attempt], deadlineAt))) {
          void attempt.then(
            () => this.scheduleRetryAfterCleanupTimeout(record),
            () => this.scheduleRetryAfterCleanupTimeout(record),
          );
          return;
        }
        if (record.closeIntent?.phase !== 'pending') return;
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) return;
        const retryDelay = this.delay(Math.min(this.closeRetryMs, remaining));
        if (!(await this.waitForSettlements([retryDelay], deadlineAt))) return;
      }
    } finally {
      if (
        record.closeIntent &&
        this.store.get(record.session) === record &&
        record.owner === this.owner
      )
        this.store.markOrphaned(record.session);
    }
  }

  private scheduleRetryAfterCleanupTimeout(record: CmuxSessionRecord): void {
    const intent = record.closeIntent;
    if (
      intent?.phase !== 'pending' ||
      !record.paneId ||
      record.owner !== this.owner ||
      this.store.get(record.session) !== record
    )
      return;
    record.closeTimer?.cancel();
    record.closeTimer = this.timer(
      () => this.attemptClose(record),
      this.closeRetryMs,
    );
  }

  private async attemptCloseWithoutTimer(
    record: CmuxSessionRecord,
  ): Promise<void> {
    if (record.closePromise) {
      await record.closePromise;
      return;
    }
    const operation = this.performCloseWithoutTimer(record);
    const trackedOperation = operation.finally(() => {
      if (record.closePromise === trackedOperation) {
        record.closePromise = undefined;
        this.store.notifyLatePaneOrphan(record);
      }
    });
    record.closePromise = trackedOperation;
    await trackedOperation;
  }

  private async performCloseWithoutTimer(
    record: CmuxSessionRecord,
  ): Promise<void> {
    const intent = record.closeIntent;
    if (
      !intent ||
      !record.paneId ||
      record.owner !== this.owner ||
      this.store.get(record.session) !== record
    )
      return;
    const paneId = record.paneId;
    let closed = false;
    try {
      closed = await this.multiplexer.closePane(paneId);
    } catch (error) {
      log('[cmux-session-lifecycle] cleanup closePane failed; retaining pane', {
        owner: this.owner,
        session: record.session,
        paneId,
        error: String(error),
      });
    }
    const current = this.store.get(record.session);
    const ownerChanged =
      current === record &&
      record.owner !== this.owner &&
      record.paneId === paneId;
    if (ownerChanged) record.closeSettlement = { paneId, closed };
    else record.closeSettlement = undefined;
    if (
      current !== record ||
      record.owner !== this.owner ||
      record.closeIntent !== intent ||
      record.paneId !== paneId
    )
      return;
    if (closed) {
      record.closeIntent = undefined;
      this.store.removeAfterConfirmedClose(record.session);
    } else record.closeIntent = this.policy.failed(intent, this.now());
  }

  private async adoptAndClose(
    record: CmuxSessionRecord,
    paneId: string,
  ): Promise<void> {
    if (!this.store.get(record.session)) this.store.claimCreated(record);
    const current = this.store.get(record.session);
    if (current !== record || current.owner !== this.owner) return;
    this.store.markAttached(record.session, paneId, this.now());
    this.store.markOrphaned(record.session);
    await this.requestClose(record, 'cleanup');
  }

  private async closeLatePane(
    source: CmuxSessionRecord,
    paneId: string,
  ): Promise<void> {
    const session = `${source.session}\0late\0${paneId}`;
    const existing = this.store.get(session);
    if (existing) {
      if (existing.owner !== this.owner || existing.paneId !== paneId) return;
      await this.requestClose(existing, 'cleanup');
      return;
    }

    const late: CmuxSessionRecord = {
      session,
      owner: this.owner,
      ownerGeneration: this.ownerGeneration,
      parent: source.parent,
      title: source.title,
      directory: source.directory,
      paneId,
      spawnState: 'attached',
      lifecycle: 'orphaned',
      serverUrl: source.serverUrl,
      attachedAt: this.now(),
      lastActivityAt: source.lastActivityAt,
      activityVersion: source.activityVersion,
      idleConsecutive: 0,
      latePaneCleanup: true,
    };
    if (!this.store.claimCreated(late)) return;
    const current = this.store.get(session);
    if (current !== late || current.owner !== this.owner) return;

    // Keep this as a normal owner-scoped close intent. It may run after this
    // lifecycle is disposed, and a later lifecycle can claim the record if a
    // retry enters cooldown.
    await this.requestClose(current, 'cleanup');
  }

  private claimLatePaneOrphans(expectedRecord?: CmuxSessionRecord): void {
    this.recoverInitialOrphans();
    const serverUrl = this.serverScope();
    if (!serverUrl) return;
    const claimed = this.store.claimLatePaneOrphans(
      this.owner,
      this.defaultDirectory,
      serverUrl,
      this.ownerGeneration,
      expectedRecord,
    );
    this.recoverOrphans(claimed);
  }

  private recoverInitialOrphans(): void {
    if (this.initialOrphansRecovered) return;
    this.initialOrphansRecovered = true;
    const serverUrl = this.serverScope();
    if (!serverUrl) return;
    this.recoverOrphans(
      this.store.claimOrphans(
        this.owner,
        this.defaultDirectory,
        serverUrl,
        this.ownerGeneration,
      ),
    );
  }

  private recoverOrphans(orphaned: CmuxSessionRecord[]): void {
    for (const orphan of orphaned) {
      if (orphan.closePromise) {
        this.resumeTransferredClose(orphan);
        continue;
      }
      if (this.applyCloseSettlement(orphan)) continue;
      if (
        orphan.closeIntent?.phase === 'cooldown' &&
        Number.isFinite(orphan.closeIntent.nextAttemptAt)
      ) {
        this.scheduleCooldown(orphan);
      } else {
        orphan.closeIntent = undefined;
        void this.requestClose(orphan, 'cleanup');
      }
    }
  }

  private eventSession(event: CmuxSessionEvent): string | undefined {
    const payload = event.data ?? event.properties;
    return (
      payload?.sessionID ??
      payload?.info?.sessionID ??
      payload?.part?.sessionID ??
      payload?.info?.id
    );
  }

  private timer(callback: () => void | Promise<void>, milliseconds: number) {
    let cancelled = false;
    if (this.injectedDelay) {
      void this.delay(milliseconds).then(() => {
        if (!cancelled) void callback();
      });
      return { cancel: () => (cancelled = true) };
    }
    const timer = setTimeout(() => void callback(), milliseconds);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  }

  private async loadStatuses(): Promise<Record<string, { type: string }>> {
    const serverUrl = this.resolveServerUrl();
    if (!serverUrl) {
      log('[cmux-session-lifecycle] no valid server URL; skipping poll');
      throw new ServerUrlUnavailableError();
    }
    const response = await fetch(new URL('/session/status', serverUrl), {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok)
      throw new Error(`session status failed: ${response.status}`);
    return (await response.json()) as Record<string, { type: string }>;
  }
}
