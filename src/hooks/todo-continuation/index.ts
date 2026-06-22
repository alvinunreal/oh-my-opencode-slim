/**
 * Todo auto-continuation hook with background-task deferral.
 *
 * OpenCode's built-in todo auto-continue wakes the orchestrator session
 * when it goes idle with incomplete todos. The wake-up is delivered as
 * a synthetic user message injected into the prompt pipeline.
 *
 * If the orchestrator is idle only because it is waiting for one or more
 * background agents, the auto-continue should be deferred. The completion
 * of the background job will wake the orchestrator naturally with the
 * result, and continuing before then can cause duplicate work, race
 * conditions, or the orchestrator advancing past the result it was
 * actually waiting for.
 *
 * This hook:
 * - exposes a `hasActiveBackgroundTasks` predicate on the shared
 *   `BackgroundJobBoard` (see `../../utils/background-job-board.ts`);
 * - on `session.idle` (or `session.status` with type `idle`) for a
 *   managed (orchestrator) parent session, asks the board whether any
 *   background job is still non-terminal. If yes, records the session
 *   as "deferred" so any incoming synthetic auto-continue message will
 *   be suppressed on its way to the LLM;
 * - on `session.status === 'busy'` (or on session deletion), clears the
 *   deferred flag — the session has either woken up on its own or is
 *   gone, and the next idle cycle should re-evaluate;
 * - in `experimental.chat.messages.transform`, scans the outbound
 *   message list for the last user message of a deferred session. If
 *   the last user message is the synthetic auto-continue wake-up
 *   (`TextPart.synthetic === true`), the message is removed from the
 *   outbound list so it never reaches the model. Auto-continue remains
 *   enabled — only this particular wake-up is skipped, exactly as
 *   described in issue #587.
 *
 * The hook is read-only with respect to background jobs: it never
 * launches, mutates, reconciles, or cancels tasks. The
 * `BackgroundJobBoard` is the single source of truth for job state and
 * the existing `task-session-manager` keeps it in sync.
 */
import { SLIM_INTERNAL_INITIATOR_MARKER } from '../../utils';
import type { BackgroundJobBoard } from '../../utils/background-job-board';
import type { MessageWithParts } from '../types';

export interface TodoContinuationHookOptions {
  /**
   * Shared background job board. Used to query whether the parent
   * session still has active (non-terminal) background tasks.
   */
  backgroundJobBoard: BackgroundJobBoard;
  /**
   * Returns true when the given session is the orchestrator (the
   * session whose todos drive auto-continue). Subagent sessions are
   * never managed by this hook.
   */
  shouldManageSession: (sessionID: string) => boolean;
}

type SessionLifecycleEvent = {
  type: string;
  properties?: {
    info?: { id?: string };
    sessionID?: string;
    status?: { type?: string };
  };
};

/**
 * A part that is a text part and was authored synthetically (e.g. the
 * todo auto-continue wake-up). Mirrors the SDK's `TextPart.synthetic`
 * flag without importing the SDK type.
 */
function isSyntheticTextPart(part: {
  type: string;
  text?: unknown;
  synthetic?: unknown;
}): boolean {
  if (part.type !== 'text') return false;
  if (part.synthetic !== true) return false;
  if (typeof part.text !== 'string') return false;
  if (part.text.includes(SLIM_INTERNAL_INITIATOR_MARKER)) return false;
  return true;
}

export function createTodoContinuationHook(
  options: TodoContinuationHookOptions,
) {
  /**
   * Sessions that went idle with active background tasks. The next
   * synthetic auto-continue prompt targeting one of these sessions
   * will be suppressed. Cleared on `session.status === 'busy'` (the
   * session has woken up on its own) or on `session.deleted`.
   */
  const deferredSessions = new Set<string>();

  function deferIfBackgroundTasksActive(sessionID: string): void {
    if (!options.shouldManageSession(sessionID)) return;
    if (options.backgroundJobBoard.hasActiveBackgroundTasks(sessionID)) {
      deferredSessions.add(sessionID);
    } else {
      deferredSessions.delete(sessionID);
    }
  }

  function clearDeferral(sessionID: string): void {
    deferredSessions.delete(sessionID);
  }

  return {
    event: async (input: { event: SessionLifecycleEvent }): Promise<void> => {
      const event = input.event;

      if (event.type === 'session.deleted') {
        const sessionId =
          event.properties?.info?.id ?? event.properties?.sessionID;
        if (sessionId) clearDeferral(sessionId);
        return;
      }

      if (event.type === 'session.idle') {
        const sessionId =
          event.properties?.info?.id ?? event.properties?.sessionID;
        if (sessionId) deferIfBackgroundTasksActive(sessionId);
        return;
      }

      if (
        event.type === 'session.status' &&
        event.properties?.status?.type === 'idle'
      ) {
        const sessionId =
          event.properties?.info?.id ?? event.properties?.sessionID;
        if (sessionId) deferIfBackgroundTasksActive(sessionId);
        return;
      }

      if (
        event.type === 'session.status' &&
        event.properties?.status?.type === 'busy'
      ) {
        const sessionId =
          event.properties?.info?.id ?? event.properties?.sessionID;
        if (sessionId) clearDeferral(sessionId);
      }
    },

    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages: MessageWithParts[] },
    ): Promise<void> => {
      if (output.messages.length === 0) return;

      // Find the last user message in the outbound stream.
      let lastUserMessageIndex = -1;
      for (let i = output.messages.length - 1; i >= 0; i -= 1) {
        if (output.messages[i].info.role === 'user') {
          lastUserMessageIndex = i;
          break;
        }
      }
      if (lastUserMessageIndex === -1) return;

      const lastUserMessage = output.messages[lastUserMessageIndex];
      const sessionID = lastUserMessage.info.sessionID;
      if (!sessionID || !options.shouldManageSession(sessionID)) return;
      if (!deferredSessions.has(sessionID)) return;

      // Only act if the last user message is the auto-continue wake-up
      // itself — i.e. it is synthetic. If the user has typed something
      // new, the wake-up has already done its job and the new turn
      // belongs to the user.
      const isSyntheticWakeUp = lastUserMessage.parts.some(isSyntheticTextPart);
      if (!isSyntheticWakeUp) {
        // The user (or a background task) sent a real message; the
        // session is no longer in the auto-continue window.
        deferredSessions.delete(sessionID);
        return;
      }

      // Drop the synthetic wake-up so it never reaches the LLM. The
      // hook never mutates the user's authored text or non-synthetic
      // parts; it only removes the synthetic auto-continue turn.
      output.messages.splice(lastUserMessageIndex, 1);
      deferredSessions.delete(sessionID);
    },
  };
}
