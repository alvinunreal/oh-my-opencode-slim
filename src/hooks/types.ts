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
