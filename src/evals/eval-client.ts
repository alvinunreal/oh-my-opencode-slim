/**
 * Shared eval client type and factory.
 *
 * The SDK subset used by the eval system: session create, prompt, messages.
 * Extracted to avoid duplicating the inline type across session-manager.ts,
 * judge.ts, eval.ts, and eval-all.ts.
 */

import { createOpencodeClient } from '@opencode-ai/sdk';

/**
 * Partial client type — only the methods the eval system calls.
 * Narrower than the full SDK client, making mocks simpler in tests.
 */
export interface EvalSessionClient {
  session: {
    create: (opts: {
      body: { title: string };
      query: { directory: string };
    }) => Promise<{ data?: { id?: string }; error?: unknown }>;
    promptAsync: (opts: {
      path: { id: string };
      body: {
        parts: Array<
          { type: 'agent'; name: string } | { type: 'text'; text: string }
        >;
        agent: string;
      };
      query: { directory: string };
    }) => Promise<unknown>;
    messages: (opts: {
      path: { id: string };
      query: { directory: string };
    }) => Promise<unknown>;
  };
}

/**
 * Create an eval session client from the server URL.
 * Same client type used by collectSuite, runJudge, and runWithSession.
 */
export function createEvalClient(
  serveUrl: string,
  directory: string,
): ReturnType<typeof createOpencodeClient> {
  return createOpencodeClient({
    baseUrl: serveUrl,
    directory,
  });
}
