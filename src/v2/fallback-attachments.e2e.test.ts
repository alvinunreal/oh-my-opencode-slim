/**
 * End-to-end verification for the fallback attachment-preservation fix
 * (PR #1111 / commit 4a5a553).
 *
 * Drives the PRODUCTION chain — real `ForegroundFallbackManager` → real
 * `getClient` → real v2 client shim (`buildPluginInput`) — with only the
 * v2 host context mocked. Asserts that a rate-limit failover after an
 * attachment-bearing user message replays the attachment through the v2
 * prompt `files` field instead of dropping it:
 *
 *   transcript (`session.context`) → shim `messages` mapping →
 *   `isReplayableUserMessage` → `partsFromReplayMessage` → v1 promptBody
 *   assembly → shim `promptAsync` (switchModel + steer) → v2 prompt.
 */
import { describe, expect, mock, test } from 'bun:test';
import { ForegroundFallbackManager } from '../hooks/foreground-fallback';
import { buildPluginInput } from './client-shim';
import type { V2Context } from './types';

// The foreground-fallback suite (which runs earlier in the single-process
// full-suite run) replaces `opencode-client` with a client lacking
// `messages`. Re-mock it back to the passthrough so this e2e exercises the
// REAL getClient → shim wiring instead of that leaked fixture.
mock.module('../utils/opencode-client', () => ({
  getClient: (input: { client?: unknown }) => input?.client,
}));

interface Call {
  m: string;
  i: unknown;
}

function makeCtx(overrides: Partial<V2Context['session']>): {
  ctx: V2Context;
  seq: Call[];
} {
  const seq: Call[] = [];
  const ctx = {
    app: { name: 'opencode2', version: 'test' },
    options: {},
    agent: {
      transform: async () => ({ dispose() {} }),
      reload: async () => {},
      list: async () => [],
    },
    tool: {
      transform: async () => ({ dispose() {} }),
      hook: async () => ({ dispose() {} }),
    },
    command: {
      transform: async () => ({ dispose() {} }),
      list: async () => [],
    },
    session: {
      hook: async () => ({ dispose() {} }),
      interrupt: async (i: unknown) => {
        seq.push({ m: 'interrupt', i });
        return { interrupted: true };
      },
      switchModel: async (i: unknown) => {
        seq.push({ m: 'switchModel', i });
      },
      prompt: async (i: Record<string, unknown>) => {
        seq.push({ m: 'prompt', i });
        return {};
      },
      ...overrides,
    },
    event: {
      subscribe() {
        return {} as never;
      },
    },
    location: {
      directory: '/proj',
      project: { id: 'proj_1', directory: '/proj', canonical: '/proj' },
    },
  } as unknown as V2Context;
  return { ctx, seq };
}

const ATTACHMENT_TRANSCRIPT = [
  {
    id: 'm0',
    role: 'assistant',
    content: [{ type: 'text', text: 'prior answer' }],
  },
  {
    id: 'm1',
    role: 'user',
    content: [
      { type: 'text', text: 'analyze the chart' },
      {
        type: 'image',
        url: 'data:image/png;base64,BBBB',
        filename: 'att.png',
      },
    ],
  },
];

async function triggerFailover(
  ctx: V2Context,
  options?: {
    onSessionModelChanged?: (sessionID: string, model: string) => void;
  },
): Promise<ForegroundFallbackManager> {
  const input = buildPluginInput(ctx);
  const mgr = new ForegroundFallbackManager(
    { orchestrator: ['anthropic/claude-a', 'anthropic/claude-b'] },
    true,
    input as never,
    3,
    undefined,
    options?.onSessionModelChanged,
  );
  await mgr.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'ses_e2e',
        providerID: 'anthropic',
        modelID: 'claude-a',
        agent: 'orchestrator',
        role: 'assistant',
      },
    },
  });
  await mgr.handleEvent({
    type: 'session.error',
    properties: {
      sessionID: 'ses_e2e',
      error: { message: 'Rate limit exceeded' },
    },
  });
  return mgr;
}

describe('v2 fallback replay attachment preservation (e2e)', () => {
  test('rate-limit failover replays attachments through prompt files', async () => {
    const { ctx, seq } = makeCtx({
      context: async () => ATTACHMENT_TRANSCRIPT,
    });
    await triggerFailover(ctx);

    const promptCall = seq.find((e) => e.m === 'prompt');
    if (!promptCall) {
      throw new Error('no v2 prompt call captured — fallback did not fire');
    }
    const pi = promptCall.i as Record<string, unknown>;
    expect(pi.files).toEqual([
      { uri: 'data:image/png;base64,BBBB', name: 'att.png' },
    ]);
    expect(pi.delivery).toBe('steer');
    expect(pi.sessionID).toBe('ses_e2e');
    expect(pi.text).toContain('analyze the chart');
    expect(pi.text).toContain('system-reminder');

    const switchIdx = seq.findIndex((e) => e.m === 'switchModel');
    const promptIdx = seq.indexOf(promptCall);
    expect(switchIdx).toBeGreaterThanOrEqual(0);
    expect(switchIdx).toBeLessThan(promptIdx);
    expect(seq[switchIdx]?.i).toMatchObject({
      sessionID: 'ses_e2e',
      model: { id: 'claude-b', providerID: 'anthropic' },
    });
  });

  test('transcript without attachments prompts without a files key', async () => {
    const { ctx, seq } = makeCtx({
      context: async () => [
        {
          id: 'm1',
          role: 'user',
          content: [{ type: 'text', text: 'plain retry' }],
        },
      ],
    });
    await triggerFailover(ctx);

    const promptCall = seq.find((e) => e.m === 'prompt');
    if (!promptCall) {
      throw new Error('no v2 prompt call captured — fallback did not fire');
    }
    const pi = promptCall.i as Record<string, unknown>;
    expect(pi.files).toBeUndefined();
    expect(pi.text).toContain('plain retry');
  });
});

describe('v2 fallback model-switch hardening (e2e, upstream #1125)', () => {
  const PLAIN_TRANSCRIPT = [
    {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'analyze the chart' }],
    },
  ];

  test('switchModel failure still delivers the replay and skips the switch claim', async () => {
    // Real manager → real shim: a failing host switchModel must degrade to
    // a steer prompt on the current model (chain not aborted) while the
    // manager's bookkeeping records NO switch.
    const { ctx, seq } = makeCtx({
      context: async () => PLAIN_TRANSCRIPT,
      switchModel: async (i: unknown) => {
        seq.push({ m: 'switchModel-failed', i });
        throw new Error('model not available on host');
      },
    });
    const onModelChanged = mock();
    await triggerFailover(ctx, { onSessionModelChanged: onModelChanged });

    const promptCall = seq.find((e) => e.m === 'prompt');
    if (!promptCall) {
      throw new Error(
        'no v2 prompt call captured — degrade dropped the replay',
      );
    }
    const pi = promptCall.i as Record<string, unknown>;
    expect(pi.delivery).toBe('steer');
    expect(pi.text).toContain('analyze the chart');
    // No busy-session abort dance around the degraded delivery.
    expect(seq.filter((e) => e.m === 'interrupt')).toHaveLength(0);
    expect(seq.filter((e) => e.m === 'prompt')).toHaveLength(1);
    // The switch claim (bookkeeping callback) must NOT fire — the session
    // is still on the model that failed.
    expect(onModelChanged).not.toHaveBeenCalled();
  });

  test('host without switchModel rejects the replay without aborting or retrying', async () => {
    const { ctx, seq } = makeCtx({
      context: async () => PLAIN_TRANSCRIPT,
    });
    // Reduced host: no session.switchModel capability at all.
    delete (ctx.session as Partial<V2Context['session']>).switchModel;
    const onModelChanged = mock();
    await triggerFailover(ctx, { onSessionModelChanged: onModelChanged });

    // No silent same-model steering: the replay is rejected (no prompt
    // delivered), the error is NOT misclassified as a busy session (no
    // interrupt/abort, no retry), and no switch is claimed.
    expect(seq.filter((e) => e.m === 'prompt')).toHaveLength(0);
    expect(seq.filter((e) => e.m === 'interrupt')).toHaveLength(0);
    expect(onModelChanged).not.toHaveBeenCalled();
  });
});
