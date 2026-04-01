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
  createdAt: number;
  lastSeenAt: number;
  missingSince?: number;
}

/**
 * Event shape for session events
 */
interface SessionEvent {
  type: string;
  properties?: {
    info?: { id?: string; parentID?: string; title?: string };
    sessionID?: string;
    status?: { type: string };
  };
}

const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_MISSING_GRACE_MS = POLL_INTERVAL_BACKGROUND_MS * 3;

/**
 * MultiplexerSessionManager tracks child sessions and spawns/closes multiplexer panes for them.
 *
 * Uses session.status events for completion detection instead of polling.
 * Supports both tmux and zellij multiplexers.
 */
export class MultiplexerSessionManager {
  private client: OpencodeClient;
  private serverUrl: string;
  private multiplexer: Multiplexer | null = null;
  private sessions = new Map<string, TrackedSession>();
  private pollInterval?: ReturnType<typeof setInterval>;
  private enabled = false;

  constructor(ctx: PluginInput, config: MultiplexerConfig) {
    this.client = ctx.client;
    const defaultPort = process.env.OPENCODE_PORT ?? '4096';
    this.serverUrl =
      ctx.serverUrl?.toString() ?? `http://localhost:${defaultPort}`;

    // Get the multiplexer instance
    this.multiplexer = getMultiplexer(config);

    // Enable only if a multiplexer is configured and we're inside a session
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

  /**
   * Handle session.created events.
   * Spawns a multiplexer pane for child sessions (those with parentID).
   */
  async onSessionCreated(event: SessionEvent): Promise<void> {
    if (!this.enabled || !this.multiplexer) return;
    if (event.type !== 'session.created') return;

    const info = event.properties?.info;
    if (!info?.id || !info?.parentID) {
      // Not a child session, skip
      return;
    }

    const sessionId = info.id;
    const parentId = info.parentID;
    const title = info.title ?? 'Subagent';

    // Skip if we're already tracking this session
    if (this.sessions.has(sessionId)) {
      log('[multiplexer-session-manager] session already tracked', {
        sessionId,
      });
      return;
    }

    // Check server is running before spawning
    const serverRunning = await isServerRunning(this.serverUrl);
    if (!serverRunning) {
      log('[multiplexer-session-manager] server not running, skipping', {
        serverUrl: this.serverUrl,
      });
      return;
    }

    log('[multiplexer-session-manager] child session created, spawning pane', {
      sessionId,
      parentId,
      title,
    });

    const paneResult = await this.multiplexer
      .spawnPane(sessionId, title, this.serverUrl)
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
        createdAt: now,
        lastSeenAt: now,
      });

      log('[multiplexer-session-manager] pane spawned', {
        sessionId,
        paneId: paneResult.paneId,
      });

      // Start polling for fallback reliability
      this.startPolling();
    }
  }

  /**
   * Handle session.status events for completion detection.
   * Uses session.status instead of deprecated session.idle.
   *
   * When a session becomes idle (completed), close its pane.
   */
  async onSessionStatus(event: SessionEvent): Promise<void> {
    if (!this.enabled) return;
    if (event.type !== 'session.status') return;

    const sessionId = event.properties?.sessionID;
    if (!sessionId) return;

    // Check if session is idle (completed)
    if (event.properties?.status?.type === 'idle') {
      await this.closeSession(sessionId);
    }
  }

  /**
   * Handle session.deleted events.
   * When a session is deleted, close its multiplexer pane immediately.
   */
  async onSessionDeleted(event: SessionEvent): Promise<void> {
    if (!this.enabled) return;
    if (event.type !== 'session.deleted') return;

    const sessionId = event.properties?.sessionID;
    if (!sessionId) return;

    log('[multiplexer-session-manager] session deleted, closing pane', {
      sessionId,
    });

    await this.closeSession(sessionId);
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

  /**
   * Poll sessions for status updates (fallback for reliability).
   * Also handles timeout and missing session detection.
   */
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

        // Session is idle (completed).
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

        // Check for timeout as a safety fallback
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

  /**
   * Clean up all tracked sessions.
   */
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

    log('[multiplexer-session-manager] cleanup complete');
  }
}

/**
 * @deprecated Use MultiplexerSessionManager instead
 */
export const TmuxSessionManager = MultiplexerSessionManager;
