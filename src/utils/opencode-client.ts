import type { PluginInput } from '@opencode-ai/plugin';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2';

// process-scoped; cleared on process exit. Keyed by directory; the
// OpenCode server holds session state, so a cached client stays valid
// for the lifetime of the plugin process.
const clients = new Map<string, OpencodeClient>();

/**
 * Returns an OpenCode SDK client scoped to the same directory as the
 * plugin-provided input. The client exposes session methods
 * (switchModel, switchAgent) that are absent from the v1 client the
 * plugin hands us. Both target the same local server; session state
 * is server-side, so they observe identical sessions.
 */
export function getClient(input: PluginInput): OpencodeClient {
  const cached = clients.get(input.directory);
  if (cached) return cached;
  const client = createOpencodeClient({
    baseUrl: input.serverUrl?.origin ?? 'http://localhost:6090',
    directory: input.directory,
  });
  clients.set(input.directory, client);
  return client;
}
