import type { PluginInput, ProviderContext } from '@opencode-ai/plugin';
import type { Model, UserMessage } from '@opencode-ai/sdk';
import { isInternalInitiatorPart } from '../utils';
import { getClient } from '../utils/opencode-client';

interface ChatHeadersInput {
  sessionID: string;
  model: Model;
  provider: ProviderContext;
  message: UserMessage;
}

interface ChatHeadersOutput {
  headers: Record<string, string>;
}

/** Copilot routing header the hook may set (shared with the v2 bridge in
 * `src/v2/setup.ts` so both hosts stamp the exact same header/value). */
export const CHAT_INITIATOR_HEADER_NAME = 'x-initiator';
export const CHAT_INITIATOR_HEADER_AGENT = 'agent';

const INTERNAL_MARKER_CACHE_LIMIT = 1000;
const internalMarkerCache = new Map<string, boolean>();

export function __resetInternalMarkerCacheForTesting(): void {
  internalMarkerCache.clear();
}

function getProviderID(input: ChatHeadersInput): string {
  return input.provider.info?.id || input.model.providerID;
}

/** Copilot provider ids whose backend distinguishes user- vs
 * agent-initiated requests via the `x-initiator` header. Exported for the
 * v2 `session.model.request` bridge (`src/v2/setup.ts`). */
export function isCopilotProvider(providerID: string): boolean {
  return (
    providerID === 'github-copilot' ||
    providerID === 'github-copilot-enterprise'
  );
}

async function hasInternalMarker(
  input: PluginInput,
  sessionID: string,
  messageID: string,
): Promise<boolean> {
  const cacheKey = `${sessionID}:${messageID}`;
  const cached = internalMarkerCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const response = await getClient(input).session.message({
      path: { id: sessionID, messageID },
      query: { directory: input.directory },
    });
    const hasMarker = (response.data?.parts ?? []).some(
      isInternalInitiatorPart,
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

      if (!(await hasInternalMarker(ctx, input.sessionID, input.message.id))) {
        return;
      }

      output.headers[CHAT_INITIATOR_HEADER_NAME] = CHAT_INITIATOR_HEADER_AGENT;
    },
  };
}
