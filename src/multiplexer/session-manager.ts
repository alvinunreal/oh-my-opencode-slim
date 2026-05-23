import type { PluginInput } from '@opencode-ai/plugin';
import { POLL_INTERVAL_BACKGROUND_MS } from '../config';
import type { MultiplexerConfig } from '../config/schema';
import {
  getMultiplexer,
  isServerRunning,
  type Multiplexer,
} from '../multiplexer';
import type { BackgroundJobBoard } from '../utils/background-job-board';
import { log } from '../utils/logger';

interface TrackedSession {
  sessionId: string;
  paneId: string;
  parentId: string;
  title: string;
  directory: string;
  ownerInstanceId: string;
  createdAt: number;
  lastSeenAt: number;
  seenInStatus: boolean;
  missingSince?: number;
}

interface KnownSession {
  parentId: string;
  title: string;
  directory: string;
}

interface SharedSessionState {
  sessions: Map<string, TrackedSession>;
  knownSessions: Map<string, KnownSession>;
  spawningSessions: Set<string>;
  closingSessions: Map<string, Promise<void>>;
}

interface SessionEvent {
  type: string;
  properties?: {
    info?: {
      id?: string;
      parentID?: string;
      title?: string;
      directory?: string;
    };
    sessionID?: string;
    status?: { type: string };
  };
}

type CloseReason = 'idle' | 'deleted' | 'missing';

const SESSION_MISSING_GRACE_MS = POLL_INTERVAL_BACKGROUND_MS * 3;
const SHARED_STATE_KEY = Symbol.for(
  'oh-my-opencode-slim.multiplexer-session-manager.state',
);

function getSharedState(): SharedSessionState {
  const globalWithState = globalThis as typeof globalThis & {
    [SHARED_STATE_KEY]?: SharedSessionState;
  };

  globalWithState[SHARED_STATE_KEY] ??= {
    sessions: new Map(),
    knownSessions: new Map(),
    spawningSessions: new Set(),
    closingSessions: new Map(),
  };

  return globalWithState[SHARED_STATE_KEY];
}

export function resetMultiplexerSessionManagerState(): void {
  const state = getSharedState();
  state.sessions.clear();
  state.knownSessions.clear();
  state.spawningSessions.clear();
  state.closingSessions.clear();
}

/**
 * Tracks child sessions and spawns/closes multiplexer panes for them.
 *
 * Uses session.status events for completion detection instead of polling,
 * with polling kept as a fallback for reliability.
 */
export class MultiplexerSessionManager {
  private instanceId = Math.random().toString(36).slice(2, 8);
  private serverUrl: string;
  private directory: string;
  private multiplexer: Multiplexer | null = null;
  private sessions: SharedSessionState['sessions'];
  private knownSessions: SharedSessionState['knownSessions'];
  private spawningSessions: SharedSessionState['spawningSessions'];
  private closingSessions: SharedSessionState['closingSessions'];
  private pollInterval?: ReturnType<typeof setInterval>;
  private enabled = false;

  constructor(
    ctx: PluginInput,
    config: MultiplexerConfig,
    private readonly backgroundJobBoard?: BackgroundJobBoard,
  ) {
    const sharedState = getSharedState();
    this.sessions = sharedState.sessions;
    this.knownSessions = sharedState.knownSessions;
    this.spawningSessions = sharedState.spawningSessions;
    this.closingSessions = sharedState.closingSessions;

    this.directory = ctx.directory;
    const defaultPort = process.env.OPENCODE_PORT ?? '4096';
    this.serverUrl =
      ctx.serverUrl?.toString() ?? `http://localhost:${defaultPort}`;

    this.multiplexer = getMultiplexer(config);
    this.enabled =
      config.type !== 'none' &&
      this.multiplexer !== null &&
      this.multiplexer.isInsideSession();

    log('[multiplexer-session-manager] initialized', {
      instanceId: this.instanceId,
      enabled: this.enabled,
      type: config.type,
      serverUrl: this.serverUrl,
      trackedSessions: this.sessions.size,
      knownSessions: this.knownSessions.size,
    });
  }

  async onSessionCreated(event: SessionEvent): Promise<void> {
    if (!this.enabled || !this.multiplexer) return;
    if (event.type !== 'session.created') return;

    const info = event.properties?.info;
    if (!info?.id || !info?.parentID) {
      return;
    }

    const sessionId = info.id;
    const parentId = info.parentID;
    const title = info.title ?? 'Subagent';
    const directory = info.directory ?? this.directory;

    if (this.isTrackedOrSpawning(sessionId)) {
      log('[multiplexer-session-manager] session already tracked or spawning', {
        instanceId: this.instanceId,
        sessionId,
      });
      return;
    }

    const closing = this.closingSessions.get(sessionId);
    if (closing) await closing;

    if (this.isTrackedOrSpawning(sessionId)) return;

    this.knownSessions.set(sessionId, {
      parentId,
      title,
      directory,
    });

    this.spawningSessions.add(sessionId);

    try {
      const serverRunning = await isServerRunning(this.serverUrl);
      if (!serverRunning) {
        log('[multiplexer-session-manager] server not running, skipping', {
          instanceId: this.instanceId,
          serverUrl: this.serverUrl,
        });
        return;
      }

      if (this.closingSessions.has(sessionId) || this.sessions.has(sessionId)) {
        return;
      }

      log(
        '[multiplexer-session-manager] child session created, spawning pane',
        {
          sessionId,
          parentId,
          title,
          instanceId: this.instanceId,
        },
      );

      const paneResult = await this.multiplexer
        .spawnPane(sessionId, title, this.serverUrl, directory)
        .catch((err) => {
          log('[multiplexer-session-manager] failed to spawn pane', {
            instanceId: this.instanceId,
            error: String(err),
          });
          return { success: false, paneId: undefined };
        });

      if (!paneResult.success || !paneResult.paneId) return;

      if (
        !this.knownSessions.has(sessionId) ||
        this.closingSessions.has(sessionId)
      ) {
        await this.multiplexer.closePane(paneResult.paneId).catch((err) =>
          log(
            '[multiplexer-session-manager] closing stale spawned pane failed',
            {
              sessionId,
              paneId: paneResult.paneId,
              instanceId: this.instanceId,
              error: String(err),
            },
          ),
        );
        return;
      }

      const now = Date.now();
      this.sessions.set(sessionId, {
        sessionId,
        paneId: paneResult.paneId,
        parentId,
        title,
        directory,
        ownerInstanceId: this.instanceId,
        createdAt: now,
        lastSeenAt: now,
        seenInStatus: false,
      });

      log('[multiplexer-session-manager] pane spawned', {
        instanceId: this.instanceId,
        sessionId,
        paneId: paneResult.paneId,
      });

      this.startPolling();
    } finally {
      this.spawningSessions.delete(sessionId);
    }
  }

  async onSessionStatus(event: SessionEvent): Promise<void> {
    if (!this.enabled) return;

    if (event.type === 'session.idle') {
      const sessionId = event.properties?.sessionID;
      if (!sessionId) return;

      log('[multiplexer-session-manager] session idle event received', {
        instanceId: this.instanceId,
        sessionId,
        tracked: this.sessions.has(sessionId),
        known: this.knownSessions.has(sessionId),
        ownerInstanceId: this.sessions.get(sessionId)?.ownerInstanceId,
        backgroundJobState: this.backgroundJobBoard?.get(sessionId)?.state,
      });

      await this.closeSession(sessionId, 'idle');
      return;
    }

    if (event.type !== 'session.status') return;

    const sessionId = event.properties?.sessionID;
    if (!sessionId) return;

    if (event.properties?.status?.type === 'idle') {
      log('[multiplexer-session-manager] session status idle received', {
        instanceId: this.instanceId,
        sessionId,
        tracked: this.sessions.has(sessionId),
        known: this.knownSessions.has(sessionId),
        ownerInstanceId: this.sessions.get(sessionId)?.ownerInstanceId,
        backgroundJobState: this.backgroundJobBoard?.get(sessionId)?.state,
      });
      await this.closeSession(sessionId, 'idle');
      return;
    }

    if (event.properties?.status?.type === 'busy') {
      log('[multiplexer-session-manager] session busy event received', {
        instanceId: this.instanceId,
        sessionId,
        tracked: this.sessions.has(sessionId),
        known: this.knownSessions.has(sessionId),
        ownerInstanceId: this.sessions.get(sessionId)?.ownerInstanceId,
        backgroundJobState: this.backgroundJobBoard?.get(sessionId)?.state,
      });
      await this.respawnIfKnown(sessionId);
    }
  }

  async onSessionDeleted(event: SessionEvent): Promise<void> {
    if (!this.enabled) return;
    if (event.type !== 'session.deleted') return;

    const sessionId = this.getSessionId(event);
    if (!sessionId) return;

    log('[multiplexer-session-manager] session deleted, closing pane', {
      instanceId: this.instanceId,
      sessionId,
      tracked: this.sessions.has(sessionId),
      known: this.knownSessions.has(sessionId),
      ownerInstanceId: this.sessions.get(sessionId)?.ownerInstanceId,
      backgroundJobState: this.backgroundJobBoard?.get(sessionId)?.state,
    });

    await this.closeSession(sessionId, 'deleted');
  }

  private startPolling(): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(
      () => this.pollSessions(),
      POLL_INTERVAL_BACKGROUND_MS,
    );
    log('[multiplexer-session-manager] polling started', {
      instanceId: this.instanceId,
    });
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
      log('[multiplexer-session-manager] polling stopped', {
        instanceId: this.instanceId,
      });
    }
  }

  private async pollSessions(): Promise<void> {
    if (this.sessions.size === 0) {
      this.stopPolling();
      return;
    }

    try {
      const allStatuses = await this.fetchSessionStatuses();

      const now = Date.now();
      const sessionsToClose: Array<{ sessionId: string; reason: CloseReason }> =
        [];

      for (const [sessionId, tracked] of this.sessions.entries()) {
        if (tracked.ownerInstanceId !== this.instanceId) {
          log('[multiplexer-session-manager] skipping non-owner poll close', {
            instanceId: this.instanceId,
            ownerInstanceId: tracked.ownerInstanceId,
            sessionId,
            paneId: tracked.paneId,
          });
          continue;
        }

        const status = allStatuses[sessionId];
        const isIdle = status?.type === 'idle';

        if (status) {
          tracked.lastSeenAt = now;
          tracked.seenInStatus = true;
          tracked.missingSince = undefined;
        } else if (!tracked.missingSince) {
          tracked.missingSince = now;
        }

        const missingTooLong =
          !!tracked.missingSince &&
          now - tracked.missingSince >= SESSION_MISSING_GRACE_MS;
        const shouldKeepRunningBackgroundJob =
          (isIdle || missingTooLong) && this.isRunningBackgroundJob(sessionId);
        if (isIdle || missingTooLong) {
          if (shouldKeepRunningBackgroundJob) {
            log(
              '[multiplexer-session-manager] keeping running background pane',
              {
                instanceId: this.instanceId,
                sessionId,
                paneId: tracked.paneId,
                seenInStatus: tracked.seenInStatus,
              },
            );
            continue;
          }

          sessionsToClose.push({
            sessionId,
            reason: isIdle ? 'idle' : 'missing',
          });
        }
      }

      for (const { sessionId, reason } of sessionsToClose) {
        await this.closeSession(sessionId, reason);
      }
    } catch (err) {
      log('[multiplexer-session-manager] poll error', { error: String(err) });
    }
  }

  private async fetchSessionStatuses(): Promise<
    Record<string, { type: string }>
  > {
    const url = new URL('/session/status', this.serverUrl);
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });

    if (!response.ok) {
      throw new Error(
        `session status request failed: ${response.status} ${response.statusText}`,
      );
    }

    const body = await response.text();
    if (body.trim() === '') {
      throw new Error('session status response was empty');
    }

    try {
      return JSON.parse(body) as Record<string, { type: string }>;
    } catch (err) {
      throw new Error(`session status response was not valid JSON: ${err}`);
    }
  }

  private async closeSession(
    sessionId: string,
    reason: CloseReason,
  ): Promise<void> {
    if (reason === 'deleted') {
      this.knownSessions.delete(sessionId);
    }

    const existingClose = this.closingSessions.get(sessionId);
    if (existingClose) return existingClose;

    const tracked = this.sessions.get(sessionId);
    if (!tracked || !this.multiplexer) {
      log('[multiplexer-session-manager] close skipped; session not tracked', {
        instanceId: this.instanceId,
        sessionId,
        reason,
        tracked: !!tracked,
        hasMultiplexer: !!this.multiplexer,
      });
      return;
    }

    if (reason !== 'deleted' && tracked.ownerInstanceId !== this.instanceId) {
      log('[multiplexer-session-manager] close skipped; non-owner instance', {
        instanceId: this.instanceId,
        ownerInstanceId: tracked.ownerInstanceId,
        sessionId,
        paneId: tracked.paneId,
        reason,
      });
      return;
    }
    if (reason === 'deleted' && tracked.ownerInstanceId !== this.instanceId) {
      log('[multiplexer-session-manager] closing deleted pane as non-owner', {
        instanceId: this.instanceId,
        ownerInstanceId: tracked.ownerInstanceId,
        sessionId,
        paneId: tracked.paneId,
        reason,
      });
    }

    if (reason === 'idle' && this.isRunningBackgroundJob(sessionId)) {
      log(
        '[multiplexer-session-manager] close skipped; background job running',
        {
          instanceId: this.instanceId,
          sessionId,
          paneId: tracked.paneId,
          reason,
          backgroundJobState: this.backgroundJobBoard?.get(sessionId)?.state,
        },
      );
      return;
    }

    this.sessions.delete(sessionId);

    log('[multiplexer-session-manager] closing session pane', {
      instanceId: this.instanceId,
      sessionId,
      paneId: tracked.paneId,
      reason,
      backgroundJobState: this.backgroundJobBoard?.get(sessionId)?.state,
      parentId: tracked.parentId,
      title: tracked.title,
    });

    const closePromise: Promise<void> = this.multiplexer
      .closePane(tracked.paneId)
      .then(() => undefined)
      .catch((err) =>
        log('[multiplexer-session-manager] failed to close session pane', {
          instanceId: this.instanceId,
          sessionId,
          paneId: tracked.paneId,
          reason,
          error: String(err),
        }),
      )
      .finally(() => {
        this.closingSessions.delete(sessionId);
        this.updatePolling();
      });

    this.closingSessions.set(sessionId, closePromise);
    await closePromise;
  }

  private async respawnIfKnown(sessionId: string): Promise<void> {
    if (!this.enabled || !this.multiplexer) return;
    const closing = this.closingSessions.get(sessionId);
    if (closing) await closing;

    if (this.isTrackedOrSpawning(sessionId)) {
      return;
    }

    const known = this.knownSessions.get(sessionId);
    if (!known) return;

    this.spawningSessions.add(sessionId);

    try {
      const serverRunning = await isServerRunning(this.serverUrl);
      if (!serverRunning) {
        log(
          '[multiplexer-session-manager] server not running, skipping busy respawn',
          {
            instanceId: this.instanceId,
            serverUrl: this.serverUrl,
            sessionId,
          },
        );
        return;
      }

      if (this.sessions.has(sessionId) || this.closingSessions.has(sessionId)) {
        return;
      }

      log(
        '[multiplexer-session-manager] child session busy again, respawning pane',
        {
          instanceId: this.instanceId,
          sessionId,
          parentId: known.parentId,
          title: known.title,
        },
      );

      const paneResult = await this.multiplexer
        .spawnPane(sessionId, known.title, this.serverUrl, known.directory)
        .catch((err) => {
          log('[multiplexer-session-manager] failed to respawn pane', {
            instanceId: this.instanceId,
            error: String(err),
          });
          return { success: false, paneId: undefined };
        });

      if (!paneResult.success || !paneResult.paneId) return;

      if (
        !this.knownSessions.has(sessionId) ||
        this.closingSessions.has(sessionId)
      ) {
        await this.multiplexer.closePane(paneResult.paneId).catch((err) =>
          log(
            '[multiplexer-session-manager] closing stale respawned pane failed',
            {
              instanceId: this.instanceId,
              sessionId,
              paneId: paneResult.paneId,
              error: String(err),
            },
          ),
        );
        return;
      }

      const now = Date.now();
      this.sessions.set(sessionId, {
        sessionId,
        paneId: paneResult.paneId,
        parentId: known.parentId,
        title: known.title,
        directory: known.directory,
        ownerInstanceId: this.instanceId,
        createdAt: now,
        lastSeenAt: now,
        seenInStatus: false,
      });

      log('[multiplexer-session-manager] pane respawned on busy', {
        instanceId: this.instanceId,
        sessionId,
        paneId: paneResult.paneId,
      });

      this.startPolling();
    } finally {
      this.spawningSessions.delete(sessionId);
    }
  }

  private isTrackedOrSpawning(sessionId: string): boolean {
    return this.sessions.has(sessionId) || this.spawningSessions.has(sessionId);
  }

  private updatePolling(): void {
    if (this.sessions.size > 0 || this.closingSessions.size > 0) {
      this.startPolling();
    } else {
      this.stopPolling();
    }
  }

  private getSessionId(event: SessionEvent): string | undefined {
    return event.properties?.info?.id ?? event.properties?.sessionID;
  }

  private isRunningBackgroundJob(sessionId: string): boolean {
    return this.backgroundJobBoard?.get(sessionId)?.state === 'running';
  }

  async cleanup(): Promise<void> {
    this.stopPolling();

    if (this.closingSessions.size > 0) {
      await Promise.all(this.closingSessions.values());
    }

    if (this.sessions.size > 0 && this.multiplexer) {
      log('[multiplexer-session-manager] closing all panes', {
        count: this.sessions.size,
      });
      const multiplexer = this.multiplexer;
      const closePromises = Array.from(this.sessions.values()).map((s) =>
        multiplexer.closePane(s.paneId).catch((err) =>
          log('[multiplexer-session-manager] cleanup error for pane', {
            paneId: s.paneId,
            error: String(err),
          }),
        ),
      );
      await Promise.all(closePromises);
      this.sessions.clear();
    }

    this.knownSessions.clear();
    this.spawningSessions.clear();
    this.closingSessions.clear();

    log('[multiplexer-session-manager] cleanup complete');
  }
}

/**
 * @deprecated Use MultiplexerSessionManager instead
 */
export const TmuxSessionManager = MultiplexerSessionManager;
