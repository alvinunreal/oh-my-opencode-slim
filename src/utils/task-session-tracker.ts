/**
 * TaskSessionTracker
 *
 * Tracks task tool sessions so that the plugin can annotate empty/interrupted
 * results with the session's task_id, enabling the orchestrator to resume
 * rather than spawn a fresh subagent.
 *
 * Lifecycle:
 *   register()   — called when the `task` tool fires via tool.execute.after
 *   markInterrupted() / markCompleted() — update session status
 *   cleanup()    — called on session.deleted event
 */

import { log } from './logger';

export interface TrackedTaskSession {
  /** The session ID that can be passed as task_id to resume. */
  sessionId: string;
  /** Parent (orchestrator) session that spawned this task. */
  parentSessionId: string;
  /** Agent name if known (e.g. "fixer", "explorer"). */
  agent: string | undefined;
  /** Current lifecycle status of the task session. */
  status: 'active' | 'interrupted' | 'completed';
  /** Timestamp when the session was first registered. */
  createdAt: number;
}

/** Sweep tracked sessions older than this. */
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export class TaskSessionTracker {
  private sessions = new Map<string, TrackedTaskSession>();

  /**
   * Register a task session for potential resumption.
   * Called from `tool.execute.after` when the `task` tool fires.
   */
  register(sessionId: string, parentSessionId: string, agent?: string): void {
    if (this.sessions.has(sessionId)) return;

    this.sessions.set(sessionId, {
      sessionId,
      parentSessionId,
      agent,
      status: 'active',
      createdAt: Date.now(),
    });

    log('[task-session-tracker] registered', {
      sessionId,
      parentSessionId,
      agent,
    });
  }

  /**
   * Mark a session as interrupted (empty/error result, may be resumable).
   */
  markInterrupted(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    entry.status = 'interrupted';
    log('[task-session-tracker] marked interrupted', { sessionId });
  }

  /**
   * Mark a session as completed normally (no resumption needed).
   */
  markCompleted(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    entry.status = 'completed';
    log('[task-session-tracker] marked completed', { sessionId });
  }

  /**
   * Get a tracked session by its ID.
   */
  get(sessionId: string): TrackedTaskSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Clean up tracking for a deleted session.
   * Called from the `session.deleted` event handler.
   */
  cleanup(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Remove stale entries older than MAX_AGE_MS.
   * Can be called periodically as a safety net.
   */
  sweepStale(): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.createdAt > MAX_AGE_MS) {
        this.sessions.delete(id);
      }
    }
  }
}
