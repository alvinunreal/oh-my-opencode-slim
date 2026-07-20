import type { PluginInput } from '@opencode-ai/plugin';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2';

// process-scoped; cleared on process exit. Keyed by directory; the
// OpenCode server holds session state, so a cached client stays valid
// for the lifetime of the plugin process.
const v2Clients = new Map<string, OpencodeClient>();

/**
 * Returns a v2 OpenCode SDK client scoped to the same directory as the
 * plugin-provided v1 client. The v2 client exposes session methods
 * (switchModel, switchAgent) that are absent from the v1 client the
 * plugin hands us. Both clients target the same local server; session
 * state is server-side, so they observe identical sessions.
 */
export function getV2Client(input: PluginInput): OpencodeClient {
  const cached = v2Clients.get(input.directory);
  if (cached) return cached;
  const client = createOpencodeClient({
    baseUrl: input.serverUrl.origin,
    directory: input.directory,
  });
  v2Clients.set(input.directory, client);
  return client;
}
