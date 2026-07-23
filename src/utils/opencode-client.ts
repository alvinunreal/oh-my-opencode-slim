import type { PluginInput } from '@opencode-ai/plugin';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2';

// process-scoped; cleared on process exit. Keyed by directory; the
// OpenCode server holds session state, so a cached client stays valid
// for the lifetime of the plugin process.
const v2Clients = new Map<string, OpencodeClient>();

/**
 * Returns a memoized v2 OpenCode SDK client for the given plugin directory.
 * The v2 client exposes session methods (switchModel, switchAgent) not
 * available through PluginInput.client. Keyed by directory; the server
 * holds session state so a cached client is valid for the process lifetime.
 */
export function getClient(input: PluginInput): OpencodeClient {
  const cached = v2Clients.get(input.directory);
  if (cached) return cached;
  const client = createOpencodeClient({
    baseUrl: input.serverUrl.origin,
    directory: input.directory,
  });
  v2Clients.set(input.directory, client);
  return client;
}
