/**
 * Post-tool nudge - queues a delegation reminder after file reads/writes.
 * Catches the "inspect/edit files → implement myself" anti-pattern.
 */

import { PHASE_REMINDER_TEXT } from '../../config/constants';

const POST_FILE_TOOL_NUDGE = PHASE_REMINDER_TEXT;

interface ToolExecuteAfterInput {
  tool: string;
  sessionID?: string;
  callID?: string;
}

interface ChatSystemTransformInput {
  sessionID?: string;
}

interface ChatSystemTransformOutput {
  system: string[];
}

interface EventInput {
  event: {
    type: string;
    properties?: {
      info?: { id?: string };
      sessionID?: string;
    };
  };
}

interface PostFileToolNudgeOptions {
  shouldInject?: (sessionID: string) => boolean;
}

const FILE_TOOLS = new Set(['Read', 'read', 'Write', 'write']);

export function createPostFileToolNudgeHook(
  options: PostFileToolNudgeOptions = {},
) {
  const pendingSessionIds = new Set<string>();

  return {
    'tool.execute.after': async (
      input: ToolExecuteAfterInput,
      _output: unknown,
    ): Promise<void> => {
      // Only nudge for Read/Write tools once the next model call is built.
      if (!FILE_TOOLS.has(input.tool) || !input.sessionID) {
        return;
      }

      pendingSessionIds.add(input.sessionID);
    },
    'experimental.chat.system.transform': async (
      input: ChatSystemTransformInput,
      output: ChatSystemTransformOutput,
    ): Promise<void> => {
      if (!input.sessionID || !pendingSessionIds.delete(input.sessionID)) {
        return;
      }

      if (options.shouldInject && !options.shouldInject(input.sessionID)) {
        return;
      }

      output.system.push(POST_FILE_TOOL_NUDGE);
    },
    event: async (input: EventInput): Promise<void> => {
      if (input.event.type !== 'session.deleted') {
        return;
      }

      const sessionID =
        input.event.properties?.sessionID ?? input.event.properties?.info?.id;
      if (!sessionID) {
        return;
      }

      pendingSessionIds.delete(sessionID);
    },
  };
}
