import { AGENT_ORCHESTRATOR, PHASE_REMINDER_TEXT } from "../../config/constants";

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
    "experimental.chat.messages.transform": async (
      _input: Record<string, never>,
      output: { messages: MessageWithParts[] }
    ): Promise<void> => {
      const { messages } = output;
      
      const lastUserMessage = [...messages].reverse().find(m => m.info.role === "user");
      if (!lastUserMessage) return;

      // Only inject for orchestrator (or if no agent specified = main session)
      const agent = lastUserMessage.info.agent;
      if (agent && agent !== AGENT_ORCHESTRATOR) {
        return;
      }

      const textPart = lastUserMessage.parts.find(
        (p) => p.type === "text" && p.text !== undefined
      );

      if (textPart) {
        textPart.text = `${PHASE_REMINDER_TEXT}\n\n---\n\n${textPart.text}`;
      }
    },
  };
}
