import type { PluginInput, ProviderContext } from '@opencode-ai/plugin';
import type { Model, UserMessage } from '@opencode-ai/sdk';
import { hasInternalInitiatorMarker } from '../utils';

interface ChatHeadersInput {
  sessionID: string;
  model: Model;
  provider: ProviderContext;
  message: UserMessage;
}

interface ChatHeadersOutput {
  headers: Record<string, string>;
}

const INTERNAL_MARKER_CACHE_LIMIT = 1000;
const internalMarkerCache = new Map<string, boolean>();

export function __resetInternalMarkerCacheForTesting(): void {
  internalMarkerCache.clear();
}

function getProviderID(input: ChatHeadersInput): string {
  return input.provider.info?.id || input.model.providerID;
}

function isCopilotProvider(providerID: string): boolean {
  return (
    providerID === 'github-copilot' ||
    providerID === 'github-copilot-enterprise'
  );
}

async function hasInternalMarker(
  client: PluginInput['client'],
  sessionID: string,
  messageID: string,
): Promise<boolean> {
  const cacheKey = `${sessionID}:${messageID}`;
  const cached = internalMarkerCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const response = await client.session.message({
      path: { id: sessionID, messageID },
    });
    const hasMarker = (response.data?.parts ?? []).some(
      hasInternalInitiatorMarker,
    );

    if (hasMarker) {
      if (internalMarkerCache.size >= INTERNAL_MARKER_CACHE_LIMIT) {
        internalMarkerCache.clear();
      }
      internalMarkerCache.set(cacheKey, true);
    }

    return hasMarker;
  } catch {
    return false;
  }
}

export function createChatHeadersHook(ctx: PluginInput) {
  return {
    'chat.headers': async (
      input: ChatHeadersInput,
      output: ChatHeadersOutput,
    ): Promise<void> => {
      if (!isCopilotProvider(getProviderID(input))) {
        return;
      }

      if (input.model.api.npm === '@ai-sdk/github-copilot') {
        return;
      }

      if (!input.message.id || input.message.role !== 'user') {
        return;
      }

      if (
        !(await hasInternalMarker(
          ctx.client,
          input.sessionID,
          input.message.id,
        ))
      ) {
        return;
      }

      output.headers['x-initiator'] = 'agent';
    },
  };
}
