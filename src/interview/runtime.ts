import type { PluginInput } from '@opencode-ai/plugin';
import { createInternalAgentTextPart } from '../utils/internal-initiator';
import type { InterviewMessage } from './types';

export interface InterviewSessionRuntime {
  messages(sessionID: string): Promise<InterviewMessage[]>;
  notify(sessionID: string, text: string): Promise<void>;
  continue(
    sessionID: string,
    text: string,
    model?: { providerID: string; modelID: string },
  ): Promise<void>;
  rename(sessionID: string, title: string): Promise<void>;
}

/** The v1 implementation deliberately stays inside the interview boundary. */
export function createV1InterviewSessionRuntime(
  ctx: PluginInput,
): InterviewSessionRuntime {
  const client = ctx.client;

  return {
    async messages(sessionID) {
      const result = await client.session.messages({
        path: { id: sessionID },
      });
      return result.data as InterviewMessage[];
    },
    async notify(sessionID, text) {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: 'text', text }],
        },
      });
    },
    async continue(sessionID, text, model) {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          agent: 'orchestrator',
          parts: [createInternalAgentTextPart(text)],
          ...(model ? { model } : {}),
        },
      });
    },
    async rename(sessionID, title) {
      await client.session.update({
        path: { id: sessionID },
        body: { title },
      });
    },
  };
}
