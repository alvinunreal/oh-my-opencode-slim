/**
 * Shared session utilities for council and background managers.
 */

import type { PluginInput } from "@opencode-ai/plugin";

type OpencodeClient = PluginInput["client"];

/**
 * Extract the short model label from a "provider/model" string.
 * E.g. "openai/gpt-5.4-mini" → "gpt-5.4-mini"
 */
export function shortModelLabel(model: string): string {
  return model.split("/").pop() ?? model;
}

export type PromptBody = {
  messageID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  noReply?: boolean;
  system?: string;
  tools?: { [key: string]: boolean };
  parts: Array<{ type: "text"; text: string }>;
  variant?: string;
};

/**
 * Parse a model reference string into provider and model IDs.
 * @param model - Model string in format "provider/model"
 * @returns Object with providerID and modelID, or null if invalid
 */
export function parseModelReference(
  model: string
): { providerID: string; modelID: string } | null {
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= model.length - 1) {
    return null;
  }
  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  };
}

/**
 * Send a prompt to a session with optional timeout.
 * If timeout is exceeded, the session is aborted and an error is thrown.
 * @param client - OpenCode client instance
 * @param args - Arguments for session.prompt()
 * @param timeoutMs - Timeout in milliseconds (0 = no timeout)
 * @throws Error if timeout is exceeded
 */
export async function promptWithTimeout(
  client: OpencodeClient,
  args: Parameters<OpencodeClient["session"]["prompt"]>[0],
  timeoutMs: number
): Promise<void> {
  if (timeoutMs <= 0) {
    await client.session.prompt(args);
    return;
  }

  const sessionId = args.path.id;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const promptPromise = client.session.prompt(args);
    promptPromise.catch(() => {});

    await Promise.race([
      promptPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          client.session.abort({ path: { id: sessionId } }).catch(() => {});
          reject(new Error(`Prompt timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Result of extracting session content.
 * `empty` is true when the assistant produced zero text content —
 * the provider returned an empty response (e.g. rate-limited silently).
 */
export interface SessionExtractionResult {
  text: string;
  empty: boolean;
}

/**
 * Extract the result text from a session.
 * Collects all assistant messages and concatenates their text parts.
 * @param client - OpenCode client instance
 * @param sessionId - Session ID to extract from
 * @param options - Optional: `includeReasoning` (default true) controls whether
 *                  reasoning/chain-of-thought parts are included.
 * @returns Object with extracted text and an `empty` flag for zero-content detection
 */
export async function extractSessionResult(
  client: OpencodeClient,
  sessionId: string,
  options?: { includeReasoning?: boolean }
): Promise<SessionExtractionResult> {
  const includeReasoning = options?.includeReasoning ?? true;

  const messagesResult = await client.session.messages({
    path: { id: sessionId },
  });
  const messages = (messagesResult.data ?? []) as Array<{
    info?: { role: string };
    parts?: Array<{ type: string; text?: string }>;
  }>;
  const assistantMessages = messages.filter(
    (m) => m.info?.role === "assistant"
  );

  const extractedContent: string[] = [];
  for (const message of assistantMessages) {
    for (const part of message.parts ?? []) {
      const allowed = includeReasoning
        ? part.type === "text" || part.type === "reasoning"
        : part.type === "text";
      if (allowed && part.text) {
        extractedContent.push(part.text);
      }
    }
  }

  const text = extractedContent.filter((t) => t.length > 0).join("\n\n");
  return { text, empty: text.length === 0 };
}
