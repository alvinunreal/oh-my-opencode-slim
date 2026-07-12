import { POLL_INTERVAL_BACKGROUND_MS } from '../../config';
import { log } from '../../utils/logger';
import type { Multiplexer } from '../types';
import { isServerRunning } from '../types';
import { CmuxClosePolicy, type CmuxCloseReason } from './close-policy';
import { type CmuxSessionRecord, CmuxSessionStore } from './session-state';

export interface CmuxSessionEvent {
  type: string;
  properties?: {
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
  };
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
  missingGraceMs?: number;
  closeRetryMs?: number;
  closeRetryTtlMs?: number;
  closeRetryMaxAttempts?: number;
  orphanCooldownMs?: number;
  shutdownTimeoutMs?: number;
  isServerRunning?: (url: string) => Promise<boolean>;
  fetchStatuses?: () => Promise<Record<string, { type: string }>>;
}

const ACTIVITY_EVENTS = new Set([
  'message.updated',
  'message.removed',
  'message.part.updated',
  'message.part.delta',
  'message.part.removed',
]);
const MIN_LIFETIME_MS = 10_000;
const IDLE_CONFIRMATIONS = 3;

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
  private readonly missingGraceMs: number;
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

  constructor(
    private readonly owner: string,
    private readonly multiplexer: Multiplexer,
    private readonly resolveServerUrl: () => string | null,
    private readonly defaultDirectory: string,
    private readonly backgroundJobs?: BackgroundJobs,
    options: CmuxSessionLifecycleOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.injectedDelay = Boolean(options.delay);
    this.delay =
      options.delay ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.deferredRetryMs = options.deferredRetryMs ?? 2_000;
    this.deferredTtlMs = options.deferredTtlMs ?? 300_000;
    this.missingGraceMs = options.missingGraceMs ?? 30_000;
    this.closeRetryMs = options.closeRetryMs ?? 1_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    this.policy = new CmuxClosePolicy(
      options.closeRetryTtlMs,
      options.closeRetryMaxAttempts,
    );
    this.serverCheck = options.isServerRunning ?? isServerRunning;
    this.fetchStatuses = options.fetchStatuses ?? (() => this.loadStatuses());
    for (const orphan of this.store.claimOrphans(owner, defaultDirectory)) {
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

  async onSessionCreated(event: CmuxSessionEvent): Promise<void> {
    if (this.disposed) return;
    if (event.type !== 'session.created') return;
    const info = event.properties?.info;
    if (!info?.id || !info.parentID) return;
    const now = this.now();
    const record: CmuxSessionRecord = {
      session: info.id,
      owner: this.owner,
      parent: info.parentID,
      title: info.title ?? 'Subagent',
      directory: info.directory ?? this.defaultDirectory,
      spawnState: 'known',
      lifecycle: 'active',
      lastActivityAt: now,
      activityVersion: 0,
      idleConsecutive: 0,
    };
    if (!this.store.claimCreated(record)) return;
    if (record.paneId && record.lifecycle !== 'active') {
      record.closeIntent = undefined;
      await this.requestClose(record, 'cleanup');
      return;
    }
    await this.spawn(record);
  }

  async onSessionStatus(event: CmuxSessionEvent): Promise<void> {
    if (this.disposed) return;
    const session = this.eventSession(event);
    if (!session) return;
    const owned = this.store.get(session);
    if (!owned || owned.owner !== this.owner) return;
    if (ACTIVITY_EVENTS.has(event.type)) {
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
      this.activity(session);
      this.backgroundJobs?.clearDeferredClose(session);
      const record = this.store.get(session);
      if (status === 'busy' && record && !record.paneId)
        await this.spawn(record);
    }
    if (owned.paneId) this.startPolling();
  }

  async onSessionDeleted(event: CmuxSessionEvent): Promise<void> {
    if (event.type !== 'session.deleted') return;
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
    const record = this.store.get(session);
    if (record?.paneId && record.owner === this.owner) this.startPolling();
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
    if (this.disposed || record.owner !== this.owner) return;
    if (record.spawnState === 'spawning' || record.paneId) return;
    const generation = this.spawnGeneration;
    const token = record.deferredSpawn?.generation;
    record.spawnState = 'spawning';
    const operation = this.spawnOperation(record);
    record.spawnPromise = operation;
    const result = await operation;
    if (record.spawnPromise === operation) record.spawnPromise = undefined;
    const current = this.store.get(record.session);
    if (this.disposed || generation !== this.spawnGeneration) {
      const latePane = result.paneId ?? result.orphanPaneId;
      if (latePane) await this.closeLatePane(record, latePane);
      else if (current && !current.paneId)
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
    if (!(await this.serverCheck(serverUrl))) {
      return { success: false, error: 'unavailable' as const };
    }
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
        record.owner !== this.owner
      )
        return;
      await this.spawn(record, true);
    }, this.deferredRetryMs);
  }

  private cancelDeferred(record: CmuxSessionRecord): void {
    record.deferredSpawn?.timer?.cancel();
    record.deferredSpawn = undefined;
  }

  private activity(session: string): void {
    const record = this.store.get(session);
    if (!record || record.owner !== this.owner || this.disposed) return;
    this.store.markActivity(session, this.now());
    const next = this.policy.activity(record.closeIntent);
    if (!next && record.closeIntent) record.closeTimer?.cancel();
    record.closeIntent = next;
    if (!next) record.closeTimer = undefined;
  }

  private async requestClose(
    record: CmuxSessionRecord,
    reason: CmuxCloseReason,
  ): Promise<void> {
    if (!record.paneId || record.owner !== this.owner) return;
    if (
      reason === 'idle' &&
      !(this.backgroundJobs?.deferIfRunning(record.session) ?? true)
    )
      return;
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
    if (record.closeIntent !== intent) return this.attemptClose(record);
    if (
      intent.reason === 'idle' &&
      intent.expectedActivityVersion !== record.activityVersion
    ) {
      record.closeIntent = this.policy.activity(intent);
      return;
    }
    let closed = false;
    try {
      closed = await this.multiplexer.closePane(record.paneId);
    } catch {}
    if (
      this.disposed ||
      this.store.get(record.session) !== record ||
      record.owner !== this.owner ||
      record.closeIntent !== intent
    )
      return;
    const intentStillCurrent = record.closeIntent === intent;
    const idleStillCurrent =
      intent.reason !== 'idle' ||
      intent.expectedActivityVersion === record.activityVersion;
    if (closed) {
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
        ) {
          await this.spawn(record);
        }
      }
      this.updatePolling();
      return;
    }
    if (!intentStillCurrent || !idleStillCurrent) return;
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
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      const statuses = await this.fetchStatuses();
      for (const record of this.store.ownedBy(this.owner)) {
        if (!record.paneId || record.lifecycle !== 'active') continue;
        const status = statuses[record.session];
        if (!status) {
          record.statusMissingSince ??= this.now();
          if (this.now() - record.statusMissingSince < this.missingGraceMs) {
            record.idleConsecutive = 0;
            continue;
          }
        }
        if (status) record.statusMissingSince = undefined;
        if (status && status.type !== 'idle') {
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
          (final[record.session]?.type === 'idle' ||
            (!final[record.session] &&
              record.statusMissingSince !== undefined &&
              this.now() - record.statusMissingSince >= this.missingGraceMs)) &&
          version === record.activityVersion
        )
          await this.requestClose(record, 'idle');
        else this.activity(record.session);
      }
    } catch {
      // A transient status endpoint failure must not reject the interval task.
    } finally {
      this.polling = false;
    }
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
    if (this.store.ownedBy(this.owner).some((record) => record.paneId))
      this.startPolling();
    else if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async runCleanup(): Promise<void> {
    this.disposed = true;
    this.spawnGeneration += 1;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    const records = this.store.ownedBy(this.owner);
    for (const record of records) this.cancelDeferred(record);
    const pending = records.flatMap((record) =>
      record.spawnPromise ? [record.spawnPromise] : [],
    );
    if (pending.length) {
      await Promise.race([
        Promise.allSettled(pending),
        this.delay(this.shutdownTimeoutMs),
      ]);
    }
    for (const record of this.store.ownedBy(this.owner)) {
      if (!record.paneId) {
        if (!record.spawnPromise) this.store.removeWithoutPane(record.session);
        continue;
      }
      record.closeTimer?.cancel();
      record.closeTimer = undefined;
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
        await this.attemptCloseWithoutTimer(record);
        if (record.closeIntent?.phase === 'pending')
          await this.delay(this.closeRetryMs);
      }
      if (
        record.closeIntent &&
        this.store.get(record.session) === record &&
        record.owner === this.owner
      )
        this.store.markOrphaned(record.session);
    }
  }

  private async attemptCloseWithoutTimer(
    record: CmuxSessionRecord,
  ): Promise<void> {
    const intent = record.closeIntent;
    if (!intent || !record.paneId) return;
    const paneId = record.paneId;
    let closed = false;
    try {
      closed = await this.multiplexer.closePane(paneId);
    } catch {}
    if (
      this.store.get(record.session) !== record ||
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
    this.store.markAttached(record.session, paneId, this.now());
    this.store.markOrphaned(record.session);
    await this.requestClose(record, 'cleanup');
  }

  private async closeLatePane(
    source: CmuxSessionRecord,
    paneId: string,
  ): Promise<void> {
    const existing = this.store.get(source.session);
    if (existing && existing.owner !== this.owner) {
      let closed = false;
      try {
        closed = await this.multiplexer.closePane(paneId);
      } catch {}
      if (!closed) this.trackStalePane(source, paneId);
      return;
    }
    const record = existing ?? source;
    if (!existing) this.store.claimCreated(record);
    record.paneId = paneId;
    record.spawnState = 'attached';
    record.lifecycle = 'orphaned';
    record.closeIntent = this.policy.request(
      'cleanup',
      record.activityVersion,
      this.now(),
    );
    while (record.closeIntent?.phase === 'pending') {
      await this.attemptCloseWithoutTimer(record);
      if (record.closeIntent?.phase === 'pending')
        await this.delay(this.closeRetryMs);
    }
  }

  private trackStalePane(source: CmuxSessionRecord, paneId: string): void {
    const session = `${source.session}\0late\0${paneId}`;
    this.store.claimCreated({
      session,
      owner: this.owner,
      parent: source.parent,
      title: source.title,
      directory: source.directory,
      paneId,
      spawnState: 'attached',
      lifecycle: 'orphaned',
      attachedAt: this.now(),
      lastActivityAt: source.lastActivityAt,
      activityVersion: source.activityVersion,
      idleConsecutive: 0,
    });
  }

  private eventSession(event: CmuxSessionEvent): string | undefined {
    return (
      event.properties?.sessionID ??
      event.properties?.info?.sessionID ??
      event.properties?.part?.sessionID ??
      event.properties?.info?.id
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
