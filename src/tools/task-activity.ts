/**
 * Activity event shapes the tracker consumes. `info.id` is the session id
 * for session-scoped events (session.*) but the message/step id for
 * message/step-scoped events (message.updated, step-finish,
 * message.part.updated); the session id for those lives in
 * `info.sessionID`.
 *
 * Progress semantics (supervised-recovery hardening):
 * - Progress = step-finish / tool_result completion / todo-or-child delta
 *   only. A `message.updated` text trickle (streaming assistant text with no
 *   completed request accounting) must NOT count as progress; it only keeps
 *   the host TUI bookkeeping in src/index.ts alive.
 * - `message.updated` counts as progress ONLY when it is a completed
 *   assistant request (a non-null time.completed marker; an explicit
 *   non-assistant role never counts), mirroring the cache-monitor
 *   completed-request gate. Events without a role field (e.g. the v2
 *   usage-telemetry synthesis) count when the completed marker is present.
 * - `session.status` busy/retry remains a liveness touch (the child is
 *   scheduled), not a progress claim.
 *
 * Accepted consequence (documented, advisory-only): a child that streams a
 * single request for longer than the stuck threshold (120s) with no
 * completed request and no step-finish will read `possibly_stuck: true`
 * from task_status even though it is still productively streaming. The
 * flag is advisory only — it never auto-aborts, auto-cancels, or arms
 * wall-clock supervision. A completed request or step-finish at any point
 * resets the clock.
 */
export interface ActivityEvent {
  type: string;
  properties?: {
    info?: {
      id?: string;
      sessionID?: string;
      role?: string;
      time?: { completed?: unknown };
    };
    sessionID?: string;
    status?: { type?: string };
  };
}

/**
 * True when a message.updated event is a completed assistant request —
 * the only message.updated shape that counts as progress. Streaming text
 * trickles (no completed marker) return false.
 */
function isCompletedAssistantMessageEvent(event: ActivityEvent): boolean {
  if (event.type !== 'message.updated') return false;
  const info = event.properties?.info;
  if (info?.role !== undefined && info.role !== 'assistant') return false;
  const completed = (info as { time?: { completed?: unknown } } | undefined)
    ?.time?.completed;
  return completed !== undefined && completed !== null;
}

/**
 * Resolves the session id from an event, keying message/step-scoped events
 * by `info.sessionID` (never the message id) and session-scoped events by
 * `info.id`. Returns undefined when no session id is present.
 *
 * The `message.part.updated` branch exists only for session resolution
 * (deltas carry the child session in info.sessionID, never the message
 * id). Resolution is not progress: `shouldRecordActivity` deliberately has
 * no `message.part.updated` arm, so part deltas resolve-then-ignore and
 * never refresh the stuck timer.
 */
export function resolveEventSessionID(
  event: ActivityEvent,
): string | undefined {
  const info = event.properties?.info;
  if (
    event.type === 'message.updated' ||
    event.type === 'step-finish' ||
    event.type === 'message.part.updated'
  ) {
    return info?.sessionID ?? event.properties?.sessionID;
  }
  return info?.id ?? event.properties?.sessionID;
}

/**
 * True when the event is a genuine progress signal that refreshes the stuck
 * timer: step-finish completions, completed-assistant message.updated
 * observations (v1 completions and v2 usage-telemetry synthesis), or
 * session.status busy/retry liveness. Streaming message.updated text
 * trickles (no completed marker) return false and must never reset the
 * possibly-stuck clock.
 */
function shouldRecordActivity(event: ActivityEvent): boolean {
  const statusType = event.properties?.status?.type;
  return (
    (event.type === 'message.updated' &&
      isCompletedAssistantMessageEvent(event)) ||
    event.type === 'step-finish' ||
    (event.type === 'session.status' &&
      (statusType === 'busy' || statusType === 'retry'))
  );
}

/** True when the session is gone and its activity bookkeeping can be dropped. */
function shouldForgetActivity(event: ActivityEvent): boolean {
  return event.type === 'session.deleted';
}

export class TaskActivityTracker {
  private readonly activity = new Map<string, number>();

  touch(sessionID: string, now = Date.now()): void {
    if (sessionID) this.activity.set(sessionID, now);
  }

  lastActivityAt(sessionID: string): number | undefined {
    return this.activity.get(sessionID);
  }

  forget(sessionID: string): void {
    this.activity.delete(sessionID);
  }
}

/**
 * Applies an event to the tracker: records progress for genuine child
 * signals (step-finish / completed message.updated / busy-retry liveness)
 * keyed by session id, ignores streaming text trickles, forgets sessions on
 * deletion. This mirrors the wiring in src/index.ts so the event policy is
 * testable in isolation.
 */
export function applyActivityEvent(
  tracker: TaskActivityTracker,
  event: ActivityEvent,
  now = Date.now(),
  sessionID = resolveEventSessionID(event),
): void {
  if (!sessionID) return;
  if (shouldRecordActivity(event)) {
    tracker.touch(sessionID, now);
  } else if (shouldForgetActivity(event)) {
    tracker.forget(sessionID);
  }
}
