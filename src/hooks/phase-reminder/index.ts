/**
 * Phase reminder to append after each latest user message.
 *
 * Keeping this at the tail preserves immediate workflow guidance without
 * mutating the cached system prompt or prepending request-local content ahead
 * of the user's actual turn.
 */
import { PHASE_REMINDER } from '../../config/constants';
import { isInternalInitiatorPart } from '../../utils';
import {
  appendTaggedSyntheticPart,
  isTaggedPart,
} from '../cache-safe-injection';
import {
  findLatestUserMessage,
  isUserMessageWithParts,
  type MessagePart,
} from '../types';

export { PHASE_REMINDER };

export const PHASE_REMINDER_METADATA_KEY = 'oh-my-opencode-slim.phaseReminder';

export function hasPhaseReminder(part: MessagePart): boolean {
  return isTaggedPart(part, PHASE_REMINDER_METADATA_KEY);
}

interface PhaseReminderOptions {
  shouldInject?: (sessionID: string) => boolean;
}

/**
 * Creates the experimental.chat.messages.transform hook for phase reminder injection.
 * This hook runs right before sending to API, so it doesn't affect UI display.
 * Only injects for the orchestrator agent.
 */
export function createPhaseReminderHook(options: PhaseReminderOptions = {}) {
  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
    ): Promise<void> => {
      const messages = Array.isArray(output.messages) ? output.messages : [];

      const lastUserMessage = findLatestUserMessage(messages);
      if (!lastUserMessage) {
        return;
      }

      const { agent, sessionID } = lastUserMessage.info;
      if (
        agent !== 'orchestrator' ||
        !sessionID ||
        (options.shouldInject && !options.shouldInject(sessionID))
      ) {
        return;
      }

      // post-file-tool-nudge must run first so its tagged part deduplicates.
      // Append reminder as a new, separate message part instead of mutating
      // the user-authored text. This prevents the reminder from leaking into
      // the UI display and chat history (issue #448).
      for (const message of messages) {
        if (
          !isUserMessageWithParts(message) ||
          message.info.agent !== 'orchestrator' ||
          message.info.sessionID !== sessionID
        ) {
          continue;
        }

        const textPart = message.parts.find(
          (part) => part.type === 'text' && part.text !== undefined,
        );
        if (
          !textPart ||
          isInternalInitiatorPart(textPart) ||
          message.parts.some(hasPhaseReminder)
        ) {
          continue;
        }

        appendTaggedSyntheticPart(message, {
          text: PHASE_REMINDER,
          metadataKey: PHASE_REMINDER_METADATA_KEY,
        });
      }
    },
  };
}
