/**
 * Phase reminder to append after each latest user message.
 *
 * Keeping this at the tail preserves immediate workflow guidance without
 * mutating the cached system prompt or prepending request-local content ahead
 * of the user's actual turn.
 */
import { PHASE_REMINDER } from '../../config/constants';
import { isInternalInitiatorPart } from '../../utils';
import { isRecord } from '../../utils/guards';
import { isUserMessageWithParts } from '../types';

export { PHASE_REMINDER };

export const PHASE_REMINDER_METADATA_KEY = 'oh-my-opencode-slim.phaseReminder';

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

      if (messages.length === 0) {
        return;
      }

      let lastUserMessageIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (isUserMessageWithParts(messages[i])) {
          lastUserMessageIndex = i;
          break;
        }
      }

      if (lastUserMessageIndex === -1) {
        return;
      }

      const lastUserMessage = messages[lastUserMessageIndex];
      if (!isUserMessageWithParts(lastUserMessage)) {
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

      const textPartIndex = lastUserMessage.parts.findIndex(
        (p) => p.type === 'text' && p.text !== undefined,
      );

      if (textPartIndex === -1) {
        return;
      }

      const originalPart = lastUserMessage.parts[textPartIndex];
      if (isInternalInitiatorPart(originalPart)) {
        return;
      }
      if (
        lastUserMessage.parts.some(
          (part) =>
            part.synthetic === true &&
            isRecord(part.metadata) &&
            part.metadata[PHASE_REMINDER_METADATA_KEY] === true,
        )
      ) {
        return;
      }

      // Append reminder as a new, separate message part instead of mutating
      // the user-authored text. This prevents the reminder from leaking into
      // the UI display and chat history (issue #448).
      lastUserMessage.parts.push({
        type: 'text',
        synthetic: true,
        text: PHASE_REMINDER,
        metadata: { [PHASE_REMINDER_METADATA_KEY]: true },
      });
    },
  };
}
