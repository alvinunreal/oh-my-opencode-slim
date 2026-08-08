/**
 * v1 PluginInput shim.
 *
 * The v1 plugin factory expects a `PluginInput` with an HTTP `client`, project
 * metadata, and a shell. v2's plugin context exposes none of these, so this
 * shim builds a v1-shaped input whose `client` delegates the few methods the
 * plugin actually uses (session.abort/prompt/messages, app.log, tui.showToast)
 * to graceful no-ops or the v2 context. `directory` comes from `process.cwd()`
 * (v2 does not expose the project directory).
 */

import { log } from '../utils/logger';

/** Build a v1-compatible PluginInput from the v2 context. */
export function buildPluginInput(directory: string): Record<string, unknown> {
  const client = {
    session: {
      // Accept both Hono-style ({path:{id}}) and flat ({sessionID}) calls.
      abort: async (args: Record<string, unknown>) => {
        const id =
          (args?.path as { id?: string } | undefined)?.id ??
          (args?.sessionID as string | undefined);
        log('[v2][shim] session.abort (no-op on v2)', { id });
      },
      prompt: async (args: Record<string, unknown>) => {
        log('[v2][shim] session.prompt ignored (v2 manages sessions)', {
          id: args?.sessionID,
        });
        return {};
      },
      promptAsync: async (args: Record<string, unknown>) => {
        log('[v2][shim] session.promptAsync ignored', { id: args?.sessionID });
        return {};
      },
      messages: async (_args: Record<string, unknown>) => ({ data: [] }),
      status: async (_args: Record<string, unknown>) => ({ data: [] }),
      list: async () => ({ data: [] }),
    },
    app: {
      log: async (args?: Record<string, unknown>) => {
        const body = (args?.body ?? args) as
          | { level?: string; message?: string }
          | undefined;
        const level = body?.level ?? 'info';
        log(`[v2][host-log] ${level}: ${body?.message ?? ''}`);
      },
    },
    tui: {
      showToast: async (args?: Record<string, unknown>) => {
        const body = (args?.body ?? args) as { message?: string } | undefined;
        log('[v2][shim] tui.showToast (no-op on v2)', {
          message: body?.message,
        });
      },
    },
    // Misc methods the plugin may touch; all graceful no-ops.
    model: { list: async () => ({ data: [] }) },
    provider: { list: async () => ({ data: [] }) },
  };

  return {
    client,
    project: { id: 'global', directory },
    directory,
    worktree: directory,
    experimental_workspace: { register() {} },
    serverUrl: new URL('http://localhost:4096'),
    $: typeof Bun !== 'undefined' ? Bun.$ : undefined,
  };
}
