/**
 * Post-tool nudge - queues a delegation reminder after file reads/writes.
 * Catches the "inspect/edit files → implement myself" anti-pattern.
 *
 * The reminder is ephemeral: recorded on tool execution, injected via
 * system.transform, and consumed once. File tool output stays clean.
 */

import { PHASE_REMINDER } from '../../config/constants';
import { extractSessionId } from '../../utils';

interface ToolExecuteAfterInput {
  tool: string;
  sessionID?: string;
  callID?: string;
}

interface PostFileToolNudgeOptions {
  shouldInject?: (sessionID: string) => boolean;
}

const FILE_TOOLS = new Set(['Read', 'read', 'Write', 'write']);

// Module-scoped for coordination with phase-reminder hook.
const pendingSessionIds = new Set<string>();
const everPendingSessionIds = new Set<string>();

/** Check if a session was marked pending by a file tool AND has not yet been
 *  consumed by system.transform. Allows phase-reminder to skip injection
 *  when post-file-tool-nudge already handles it. */
export function hasPendingSession(sessionId: string): boolean {
  return (
    everPendingSessionIds.has(sessionId) && !pendingSessionIds.has(sessionId)
  );
}

export function createPostFileToolNudgeHook(
  options: PostFileToolNudgeOptions = {},
) {
  return {
    'tool.execute.after': async (
      input: ToolExecuteAfterInput,
      _output: unknown,
    ): Promise<void> => {
      if (!FILE_TOOLS.has(input.tool) || !input.sessionID) {
        return;
      }

      pendingSessionIds.add(input.sessionID);
      everPendingSessionIds.add(input.sessionID);
    },
    'experimental.chat.system.transform': async (
      input: { sessionID?: string },
      output: { system: string[] },
    ): Promise<void> => {
      if (!input.sessionID || !pendingSessionIds.delete(input.sessionID)) {
        return;
      }

      // Track consumption so phase-reminder can check without consuming.
      // (already tracked via everPendingSessionIds — delete from pending is
      // sufficient signal)

      if (options.shouldInject && !options.shouldInject(input.sessionID)) {
        return;
      }

      output.system.push(PHASE_REMINDER);
    },
    event: async (input: {
      event: {
        type: string;
        properties?: { info?: { id?: string }; sessionID?: string };
      };
    }): Promise<void> => {
      if (input.event.type !== 'session.deleted') return;
      const sid = extractSessionId(
        input.event.properties?.info,
        input.event.properties?.sessionID,
      );
      if (sid) {
        pendingSessionIds.delete(sid);
        everPendingSessionIds.delete(sid);
      }
    },
  };
}
