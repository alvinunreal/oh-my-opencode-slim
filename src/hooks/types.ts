/**
 * Shared message type shapes for the OpenCode plugin API's `messages` array.
 *
 * These types describe the structure of chat messages passed through
 * `experimental.chat.messages.transform` and related hooks. All fields
 * are unioned across the files that previously defined them privately —
 * optional extras are harmless under structural typing.
 */

export type MessageInfo = {
  role: string;
  agent?: string;
  sessionID?: string;
  id?: string;
};

export type MessagePart = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

export type MessageWithParts = {
  info: MessageInfo;
  parts: MessagePart[];
};

export function isMessageWithParts(message: unknown): message is MessageWithParts {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Partial<MessageWithParts>;
  return (
    !!candidate.info &&
    typeof candidate.info === 'object' &&
    typeof candidate.info.role === 'string' &&
    Array.isArray(candidate.parts)
  );
}

export function isUserMessageWithParts(
  message: unknown,
): message is MessageWithParts {
  return isMessageWithParts(message) && message.info.role === 'user';
}
