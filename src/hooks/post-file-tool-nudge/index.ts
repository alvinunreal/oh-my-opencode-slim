/**
 * Post-tool nudge - queues a delegation reminder after file reads/writes.
 * Catches the "inspect/edit files → implement myself" anti-pattern.
 *
 * The reminder is ephemeral: recorded on tool execution, injected via
 * messages.transform, and consumed once. File tool output stays clean.
 */

import { PHASE_REMINDER } from '../../config/constants';
import { isInternalInitiatorPart } from '../../utils';
import {
  hasPhaseReminder,
  PHASE_REMINDER_METADATA_KEY,
} from '../phase-reminder';
import type { SessionLifecycle } from '../session-lifecycle';
import {
  findLatestUserMessage,
  isUserMessageWithParts,
  type MessageWithParts,
} from '../types';

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
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
    ): Promise<void> => {
      if (!coordinator) {
        return;
      }

      const messages = Array.isArray(output.messages) ? output.messages : [];
      const eligible = getEligibleMessage(findLatestUserMessage(messages));
      if (!eligible) {
        return;
      }
      const { message, sessionID } = eligible;

      const hasReminder = message.parts.some(hasPhaseReminder);
      if (options.shouldInject && !options.shouldInject(sessionID)) {
        return;
      }
      if (!coordinator.consumePending(sessionID)) return;
      if (hasReminder) return;
      // This transform must run before phase-reminder so this metadata deduplicates.
      message.parts.push({
        type: 'text',
        synthetic: true,
        text: PHASE_REMINDER,
        metadata: { [PHASE_REMINDER_METADATA_KEY]: true },
      });
    },
  };
}

function getEligibleMessage(
  message: unknown,
): { message: MessageWithParts; sessionID: string } | undefined {
  if (
    !isUserMessageWithParts(message) ||
    !message.info.sessionID ||
    message.info.agent !== 'orchestrator'
  ) {
    return undefined;
  }

  const textPart = message.parts.find(
    (part) => part.type === 'text' && part.text !== undefined,
  );
  if (!textPart || isInternalInitiatorPart(textPart)) {
    return undefined;
  }

  return { message, sessionID: message.info.sessionID };
}
