import type { PluginInput } from '@opencode-ai/plugin';
import { createInternalAgentTextPart } from '../utils/internal-initiator';
import { resolveSessionAgent, withAgent } from '../utils/prompt-agent';
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
      // `noReply` suppresses the model turn but NOT the agent rewrite: an
      // agent-less body still makes OpenCode resolve its default primary and
      // durably re-home the session to `build`
      // (docs/agents/build-agent-empty-input-diagnosis.md, probe A2).
      // Resolve the agent the session is actually running under — newest USER
      // message wins, so a native compaction/summary turn can never be
      // mistaken for it — and fall back to `orchestrator` only once the probe
      // has confirmed the session has no parentID (interviews always run on
      // the user's own top-level session). An unresolvable child session
      // yields no `agent` field rather than a guess.
      const agent = await resolveSessionAgent(client, sessionID, {
        directory: ctx.directory,
      });
      await client.session.prompt({
        path: { id: sessionID },
        body: withAgent(
          {
            noReply: true,
            // `as const` because the literal is no longer in a contextually
            // typed position: withAgent() would widen `type` to string.
            parts: [{ type: 'text' as const, text }],
          },
          agent,
        ),
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

export const createInterviewSessionRuntime = createV1InterviewSessionRuntime;
