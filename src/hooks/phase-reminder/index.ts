/**
 * Phase reminder to append after each latest user message.
 *
 * Keeping this at the tail preserves immediate workflow guidance without
 * mutating the cached system prompt or prepending request-local content ahead
 * of the user's actual turn.
 */
import { PHASE_REMINDER_TEXT } from '../../config/constants';
import { SLIM_INTERNAL_INITIATOR_MARKER } from '../../utils';
import type { MessageWithParts } from '../types';

export const PHASE_REMINDER = `<internal_reminder>${PHASE_REMINDER_TEXT}</internal_reminder>`;

/**
 * Creates the experimental.chat.messages.transform hook for phase reminder injection.
 * This hook runs right before sending to API, so it doesn't affect UI display.
 * Only injects for the orchestrator agent.
 */
export function createPhaseReminderHook() {
  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages: MessageWithParts[] },
    ): Promise<void> => {
      const { messages } = output;

      if (messages.length === 0) {
        return;
      }

      let lastUserMessageIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].info.role === 'user') {
          lastUserMessageIndex = i;
          break;
        }
      }

      if (lastUserMessageIndex === -1) {
        return;
      }

      const lastUserMessage = messages[lastUserMessageIndex];
      const agent = lastUserMessage.info.agent;
      if (agent && agent !== 'orchestrator') {
        return;
      }

      const textPartIndex = lastUserMessage.parts.findIndex(
        (p) => p.type === 'text' && p.text !== undefined,
      );

      if (textPartIndex === -1) {
        return;
      }

      const originalText = lastUserMessage.parts[textPartIndex].text ?? '';
      if (originalText.includes(SLIM_INTERNAL_INITIATOR_MARKER)) {
        return;
      }
      // Prevent duplicate injection: check if any existing part already contains
      // the phase reminder (either merged into text or as a standalone part).
      if (lastUserMessage.parts.some((p) => p.text?.includes(PHASE_REMINDER))) {
        return;
      }

      // Append reminder as a new, separate message part instead of mutating
      // the user-authored text. This prevents the reminder from leaking into
      // the UI display and chat history (issue #448).
      lastUserMessage.parts.push({
        type: 'text',
        text: PHASE_REMINDER,
      });
    },
  };
}
