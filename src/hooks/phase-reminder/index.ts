/**
 * Phase reminder to inject before each user message.
 * Keeps workflow instructions in the immediate attention window
 * to combat instruction-following degradation over long contexts.
 *
 * Research: "LLMs Get Lost In Multi-Turn Conversation" (arXiv:2505.06120)
 * shows ~40% compliance drop after 2-3 turns without reminders.
 *
 * Uses experimental.chat.messages.transform so it doesn't show in UI.
 */
const PHASE_REMINDER = `<reminder>⚠️ MANDATORY: Understand→DELEGATE(! based on each agent rules)→Split-and-Parallelize(?)→Plan→Execute→Verify
Available Specialist: @oracle @librarian @explorer @designer @fixer
</reminder>`;

interface MessageInfo {
  role: string;
  agent?: string;
  sessionID?: string;
}

interface MessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

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

      // Find the last user message
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

      // Only inject for orchestrator (or if no agent specified = main session)
      const agent = lastUserMessage.info.agent;
      if (agent && agent !== 'orchestrator') {
        return;
      }

      // Find the first text part
      const textPartIndex = lastUserMessage.parts.findIndex(
        (p) => p.type === 'text' && p.text !== undefined,
      );

      if (textPartIndex === -1) {
        return;
      }

      // Prepend the reminder to the existing text
      const originalText = lastUserMessage.parts[textPartIndex].text ?? '';
      lastUserMessage.parts[textPartIndex].text =
        `${PHASE_REMINDER}\n\n---\n\n${originalText}`;
    },
  };
}
