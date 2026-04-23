import type { PluginInput } from '@opencode-ai/plugin';
import { POLL_INTERVAL_BACKGROUND_MS } from '../config';
import type { MultiplexerConfig } from '../config/schema';
import {
  getMultiplexer,
  isServerRunning,
  type Multiplexer,
} from '../multiplexer';
import { log } from '../utils/logger';

type OpencodeClient = PluginInput['client'];

interface TrackedSession {
  sessionId: string;
  paneId: string;
  parentId: string;
  title: string;
  directory: string;
  createdAt: number;
  lastSeenAt: number;
  missingSince?: number;
}

interface KnownSession {
  parentId: string;
  title: string;
  directory: string;
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

const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const SESSION_MISSING_GRACE_MS = POLL_INTERVAL_BACKGROUND_MS * 3;

/**
 * Tracks child sessions and spawns/closes multiplexer panes for them.
 *
 * Uses session.status events for completion detection instead of polling,
 * with polling kept as a fallback for reliability.
 */
export class MultiplexerSessionManager {
  private client: OpencodeClient;
  private serverUrl: string;
  private directory: string;
  private multiplexer: Multiplexer | null = null;
  private sessions = new Map<string, TrackedSession>();
  private knownSessions = new Map<string, KnownSession>();
  private spawningSessions = new Set<string>();
  private pollInterval?: ReturnType<typeof setInterval>;
  private enabled = false;

  constructor(ctx: PluginInput, config: MultiplexerConfig) {
    this.client = ctx.client;
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
      enabled: this.enabled,
      type: config.type,
      serverUrl: this.serverUrl,
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

    this.knownSessions.set(sessionId, {
      parentId,
      title,
      directory,
    });

    if (this.isTrackedOrSpawning(sessionId)) {
      log('[multiplexer-session-manager] session already tracked or spawning', {
        sessionId,
      });
      return;
    }

    this.spawningSessions.add(sessionId);

    try {
      const serverRunning = await isServerRunning(this.serverUrl);
      if (!serverRunning) {
        log('[multiplexer-session-manager] server not running, skipping', {
          serverUrl: this.serverUrl,
        });
        return;
      }

      if (this.sessions.has(sessionId)) {
        return;
      }

      log(
        '[multiplexer-session-manager] child session created, spawning pane',
        {
          sessionId,
          parentId,
          title,
        },
      );

      const paneResult = await this.multiplexer
        .spawnPane(sessionId, title, this.serverUrl, directory)
        .catch((err) => {
          log('[multiplexer-session-manager] failed to spawn pane', {
            error: String(err),
          });
          return { success: false, paneId: undefined };
        });

      if (paneResult.success && paneResult.paneId) {
        const now = Date.now();
        this.sessions.set(sessionId, {
          sessionId,
          paneId: paneResult.paneId,
          parentId,
          title,
          directory,
          createdAt: now,
          lastSeenAt: now,
        });

        log('[multiplexer-session-manager] pane spawned', {
          sessionId,
          paneId: paneResult.paneId,
        });

        this.startPolling();
      }
    } finally {
      this.spawningSessions.delete(sessionId);
    }
  }

  async onSessionStatus(event: SessionEvent): Promise<void> {
    if (!this.enabled) return;
    if (event.type !== 'session.status') return;

    const sessionId = event.properties?.sessionID;
    if (!sessionId) return;

    if (event.properties?.status?.type === 'idle') {
      await this.closeSession(sessionId);
      return;
    }

    if (event.properties?.status?.type === 'busy') {
      await this.respawnIfKnown(sessionId);
    }
  }

  async onSessionDeleted(event: SessionEvent): Promise<void> {
    if (!this.enabled) return;
    if (event.type !== 'session.deleted') return;

    const sessionId = event.properties?.sessionID;
    if (!sessionId) return;

    log('[multiplexer-session-manager] session deleted, closing pane', {
      sessionId,
    });

    await this.closeSession(sessionId);
    this.knownSessions.delete(sessionId);
  }

  private startPolling(): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(
      () => this.pollSessions(),
      POLL_INTERVAL_BACKGROUND_MS,
    );
    log('[multiplexer-session-manager] polling started');
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
      log('[multiplexer-session-manager] polling stopped');
    }
  }

  private async pollSessions(): Promise<void> {
    if (this.sessions.size === 0) {
      this.stopPolling();
      return;
    }

    try {
      const statusResult = await this.client.session.status();
      const allStatuses = (statusResult.data ?? {}) as Record<
        string,
        { type: string }
      >;

      const now = Date.now();
      const sessionsToClose: string[] = [];

      for (const [sessionId, tracked] of this.sessions.entries()) {
        const status = allStatuses[sessionId];
        const isIdle = status?.type === 'idle';

        if (status) {
          tracked.lastSeenAt = now;
          tracked.missingSince = undefined;
        } else if (!tracked.missingSince) {
          tracked.missingSince = now;
        }

        const missingTooLong =
          !!tracked.missingSince &&
          now - tracked.missingSince >= SESSION_MISSING_GRACE_MS;
        const isTimedOut = now - tracked.createdAt > SESSION_TIMEOUT_MS;

        if (isIdle || missingTooLong || isTimedOut) {
          sessionsToClose.push(sessionId);
        }
      }

      for (const sessionId of sessionsToClose) {
        await this.closeSession(sessionId);
      }
    } catch (err) {
      log('[multiplexer-session-manager] poll error', { error: String(err) });
    }
  }

  private async closeSession(sessionId: string): Promise<void> {
    const tracked = this.sessions.get(sessionId);
    if (!tracked || !this.multiplexer) return;

    log('[multiplexer-session-manager] closing session pane', {
      sessionId,
      paneId: tracked.paneId,
    });

    await this.multiplexer.closePane(tracked.paneId);
    this.sessions.delete(sessionId);

    if (this.sessions.size === 0) {
      this.stopPolling();
    }
  }

  private async respawnIfKnown(sessionId: string): Promise<void> {
    if (!this.enabled || !this.multiplexer) return;
    if (this.isTrackedOrSpawning(sessionId)) return;

    const known = this.knownSessions.get(sessionId);
    if (!known) return;

    this.spawningSessions.add(sessionId);

    try {
      const serverRunning = await isServerRunning(this.serverUrl);
      if (!serverRunning) {
        log(
          '[multiplexer-session-manager] server not running, skipping busy respawn',
          {
            serverUrl: this.serverUrl,
            sessionId,
          },
        );
        return;
      }

      if (this.sessions.has(sessionId)) return;

      log(
        '[multiplexer-session-manager] child session busy again, respawning pane',
        {
          sessionId,
          parentId: known.parentId,
          title: known.title,
        },
      );

      const paneResult = await this.multiplexer
        .spawnPane(sessionId, known.title, this.serverUrl, known.directory)
        .catch((err) => {
          log('[multiplexer-session-manager] failed to respawn pane', {
            error: String(err),
          });
          return { success: false, paneId: undefined };
        });

      if (!paneResult.success || !paneResult.paneId) return;

      const now = Date.now();
      this.sessions.set(sessionId, {
        sessionId,
        paneId: paneResult.paneId,
        parentId: known.parentId,
        title: known.title,
        directory: known.directory,
        createdAt: now,
        lastSeenAt: now,
      });

      log('[multiplexer-session-manager] pane respawned on busy', {
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

  async cleanup(): Promise<void> {
    this.stopPolling();

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

    log('[multiplexer-session-manager] cleanup complete');
  }
}

/**
 * @deprecated Use MultiplexerSessionManager instead
 */
export const TmuxSessionManager = MultiplexerSessionManager;
