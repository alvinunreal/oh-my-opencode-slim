/**
 * Post-tool nudge - queues a delegation reminder after file reads/writes.
 * Catches the "inspect/edit files → implement myself" anti-pattern.
 *
 * The reminder is ephemeral: recorded on tool execution, injected via
 * system.transform, and consumed once. File tool output stays clean.
 */

import { PHASE_REMINDER } from '../../config/constants';
import type { SessionLifecycle } from '../session-lifecycle';

const FILE_TOOLS = new Set(['Read', 'read', 'Write', 'write']);

interface PostFileToolNudgeOptions {
  shouldInject?: (sessionID: string) => boolean;
  coordinator?: SessionLifecycle;
}

export function createPostFileToolNudgeHook(
  options: PostFileToolNudgeOptions = {},
) {
  const { coordinator } = options;

  if (coordinator) {
    coordinator.onSessionDeleted((sid) => coordinator.clearSession(sid));
  }

  return {
    'tool.execute.after': async (
      input: { tool: string; sessionID?: string; callID?: string },
      _output: unknown,
    ): Promise<void> => {
      if (!FILE_TOOLS.has(input.tool) || !input.sessionID) return;
      coordinator?.markPending(input.sessionID);
    },
    'experimental.chat.system.transform': async (
      input: { sessionID?: string },
      output: { system: string[] },
    ): Promise<void> => {
      if (!input.sessionID || !coordinator?.consumePending(input.sessionID)) {
        return;
      }
      if (options.shouldInject && !options.shouldInject(input.sessionID)) {
        return;
      }
      output.system.push(PHASE_REMINDER);
    },
  };
}
