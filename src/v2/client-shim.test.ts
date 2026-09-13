import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isReplayableUserMessage,
  partsFromReplayMessage,
} from '../hooks/types';
import { createInternalAgentTextPart } from '../utils/internal-initiator';
import { buildPluginInput } from './client-shim';
import type { V2Context } from './types';

function makeCtx(overrides?: Partial<V2Context['session']>): V2Context {
  return {
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
  } as never;
}

describe('v2 client shim delegation', () => {
  test('messages maps session.context to v1 {data} with info/parts', async () => {
    const calls: unknown[] = [];
    const input = buildPluginInput(
      makeCtx({
        context: async (i: { sessionID: string }) => {
          calls.push(i);
          return [
            {
              id: 'm1',
              role: 'user',
              content: [{ type: 'text', text: 'hello' }],
            },
          ];
        },
      } as never),
    );
    const res = await (
      input.client as {
        session: {
          messages: (a: unknown) => Promise<{ data: unknown[] }>;
        };
      }
    ).session.messages({ path: { id: 'ses_1' } });
    expect(calls).toEqual([{ sessionID: 'ses_1' }]);
    expect(res.data).toEqual([
      {
        info: { id: 'm1', role: 'user' },
        parts: [{ type: 'text', text: 'hello' }],
      },
    ]);
  });

  test('promptAsync switches model then steers when body.model present', async () => {
    const seq: Array<{ m: string; i: unknown }> = [];
    const input = buildPluginInput(
      makeCtx({
        switchModel: async (i: unknown) => {
          seq.push({ m: 'switchModel', i });
        },
        prompt: async (i: unknown) => {
          seq.push({ m: 'prompt', i });
          return {};
        },
      } as never),
    );
    await (
      input.client as {
        session: { promptAsync: (a: unknown) => Promise<unknown> };
      }
    ).session.promptAsync({
      path: { id: 'ses_1' },
      body: {
        model: { providerID: 'anthropic', modelID: 'claude-x' },
        agent: 'orchestrator',
        parts: [
          { type: 'text', text: 'retry me' },
          { type: 'text', synthetic: true, text: 'reminder' },
        ],
      },
    });
    expect(seq[0]).toMatchObject({
      m: 'switchModel',
      i: {
        sessionID: 'ses_1',
        model: { id: 'claude-x', providerID: 'anthropic' },
      },
    });
    // NOTE: assert `text` outside toMatchObject — Bun v1.4.0's
    // toMatchObject mutates the received object when an asymmetric
    // matcher (stringContaining) is nested inside it.
    expect(seq[1]).toMatchObject({
      m: 'prompt',
      i: { sessionID: 'ses_1', delivery: 'steer' },
    });
    expect((seq[1].i as { text: string }).text).toContain('retry me');
  });

  test('promptAsync without a body model prompts directly', async () => {
    const seq: Array<{ m: string; i: unknown }> = [];
    const input = buildPluginInput(
      makeCtx({
        switchModel: async (i: unknown) => {
          seq.push({ m: 'switchModel', i });
        },
        prompt: async (i: unknown) => {
          seq.push({ m: 'prompt', i });
          return {};
        },
      } as never),
    );
    await (
      input.client as {
        session: { promptAsync: (a: unknown) => Promise<unknown> };
      }
    ).session.promptAsync({
      path: { id: 'ses_1' },
      body: { parts: [{ type: 'text', text: 'plain steer' }] },
    });
    expect(seq).toHaveLength(1);
    expect(seq[0]).toMatchObject({
      m: 'prompt',
      i: { sessionID: 'ses_1', delivery: 'steer', text: 'plain steer' },
    });
  });

  test('promptAsync threads an optional queue delivery (orchestrator-wake) and keeps switchModel ordering', async () => {
    const seq: Array<{ m: string; i: unknown }> = [];
    const input = buildPluginInput(
      makeCtx({
        switchModel: async (i: unknown) => {
          seq.push({ m: 'switchModel', i });
        },
        prompt: async (i: unknown) => {
          seq.push({ m: 'prompt', i });
          return {};
        },
      } as never),
    );
    const promptAsync = (
      input.client as {
        session: {
          promptAsync: (
            a: Record<string, unknown> & { delivery?: 'steer' | 'queue' },
          ) => Promise<unknown>;
        };
      }
    ).session.promptAsync;
    // Wake call shape: model selection + delivery 'queue'.
    await promptAsync({
      path: { id: 'ses_1' },
      query: { directory: '/proj' },
      body: {
        agent: 'orchestrator',
        model: { providerID: 'test', modelID: 'model-a' },
        parts: [{ type: 'text', text: 'wake reminder' }],
      },
      delivery: 'queue',
      throwOnError: true,
    });
    expect(seq).toHaveLength(2);
    expect(seq[0]).toMatchObject({ m: 'switchModel' });
    expect(seq[1]).toMatchObject({
      m: 'prompt',
      i: { sessionID: 'ses_1', delivery: 'queue', text: 'wake reminder' },
    });
    // Regression: without the delivery argument the default stays 'steer'
    // (foreground-fallback depends on steering an in-flight run).
    await promptAsync({
      path: { id: 'ses_1' },
      body: { parts: [{ type: 'text', text: 'fallback replay' }] },
    });
    expect(seq[2]).toMatchObject({
      m: 'prompt',
      i: { sessionID: 'ses_1', delivery: 'steer', text: 'fallback replay' },
    });
  });

  test('promptAsync keeps prompting as the degraded path when the host lacks session.synthetic', async () => {
    // Degraded host (no session.synthetic): the v1 wake prompt's part
    // metadata cannot survive the text-only v2 translation, so the marker
    // travels as prompt `metadata` (accepted and propagated by the v2
    // session.prompt endpoint + hook) — the session-prompt bridge can
    // still restore it so observeChatMessage does NOT classify the wake
    // admission as external user activity. On such hosts the wake stays a
    // visible user message (pre-fix behavior); hosts with session.synthetic
    // route through it instead (see the tests below).
    const seq: Array<{ m: string; i: unknown }> = [];
    const input = buildPluginInput(
      makeCtx({
        prompt: async (i: unknown) => {
          seq.push({ m: 'prompt', i });
          return {};
        },
      } as never),
    );
    const promptAsync = (
      input.client as {
        session: {
          promptAsync: (
            a: Record<string, unknown> & { delivery?: 'steer' | 'queue' },
          ) => Promise<unknown>;
        };
      }
    ).session.promptAsync;
    // Internal wake prompt (real ORCHESTRATOR_CHILDREN_WAKE_TEXT part shape).
    await promptAsync({
      path: { id: 'ses_1' },
      body: {
        agent: 'orchestrator',
        parts: [createInternalAgentTextPart('wake reminder')],
      },
      delivery: 'queue',
      throwOnError: true,
    });
    expect(seq[0]).toMatchObject({
      m: 'prompt',
      i: {
        sessionID: 'ses_1',
        delivery: 'queue',
        metadata: { 'oh-my-opencode-slim.internalInitiator': true },
      },
    });
    expect((seq[0].i as { text: string }).text).toContain(
      'SLIM_INTERNAL_INITIATOR',
    );
    // Plain external prompts carry no metadata key.
    await promptAsync({
      path: { id: 'ses_1' },
      body: { parts: [{ type: 'text', text: 'user says hi' }] },
    });
    expect(seq[1].i).not.toHaveProperty('metadata');
  });

  test('promptAsync routes internal-initiator bodies through session.synthetic', async () => {
    // v2 session.synthetic admits the wake text WITHOUT persisting it as
    // user input: no visible user bubble in the TUI, model still sees it,
    // and `resume: true` (default wake) keeps the wake semantics.
    const seq: Array<{ m: string; i: unknown }> = [];
    const input = buildPluginInput(
      makeCtx({
        prompt: async (i: unknown) => {
          seq.push({ m: 'prompt', i });
          return {};
        },
        synthetic: async (i: unknown) => {
          seq.push({ m: 'synthetic', i });
          return { admitted: true };
        },
      } as never),
    );
    const result = await (
      input.client as {
        session: {
          promptAsync: (
            a: Record<string, unknown> & { delivery?: 'steer' | 'queue' },
          ) => Promise<unknown>;
        };
      }
    ).session.promptAsync({
      path: { id: 'ses_1' },
      body: {
        agent: 'orchestrator',
        parts: [createInternalAgentTextPart('wake reminder')],
      },
      delivery: 'queue',
      throwOnError: true,
    });
    expect(seq).toHaveLength(1);
    expect(seq[0].m).toBe('synthetic');
    expect(seq[0].i).toMatchObject({
      sessionID: 'ses_1',
      delivery: 'queue',
      resume: true,
      metadata: { 'oh-my-opencode-slim.internalInitiator': true },
    });
    expect(typeof (seq[0].i as { description?: unknown }).description).toBe(
      'string',
    );
    expect((seq[0].i as { text: string }).text).toContain(
      'SLIM_INTERNAL_INITIATOR',
    );
    expect(result).toMatchObject({ admitted: true });
  });

  test('internal-initiator synthetic routing keeps switchModel ordering', async () => {
    const seq: Array<{ m: string; i: unknown }> = [];
    const input = buildPluginInput(
      makeCtx({
        switchModel: async (i: unknown) => {
          seq.push({ m: 'switchModel', i });
        },
        prompt: async (i: unknown) => {
          seq.push({ m: 'prompt', i });
          return {};
        },
        synthetic: async (i: unknown) => {
          seq.push({ m: 'synthetic', i });
          return {};
        },
      } as never),
    );
    await (
      input.client as {
        session: { promptAsync: (a: unknown) => Promise<unknown> };
      }
    ).session.promptAsync({
      path: { id: 'ses_1' },
      body: {
        agent: 'orchestrator',
        model: { providerID: 'anthropic', modelID: 'claude-x' },
        parts: [createInternalAgentTextPart('wake with model pin')],
      },
    });
    expect(seq.map((c) => c.m)).toEqual(['switchModel', 'synthetic']);
    expect(seq[1].i).toMatchObject({
      sessionID: 'ses_1',
      delivery: 'steer',
    });
  });

  test('plain external prompts never route through session.synthetic', async () => {
    // foreground-fallback replays real user parts through promptAsync —
    // those must keep hitting session.prompt even on synthetic-capable
    // hosts, or the fallback replay would stop being persisted as the
    // session's user input.
    const seq: Array<{ m: string; i: unknown }> = [];
    const input = buildPluginInput(
      makeCtx({
        prompt: async (i: unknown) => {
          seq.push({ m: 'prompt', i });
          return {};
        },
        synthetic: async (i: unknown) => {
          seq.push({ m: 'synthetic', i });
          return {};
        },
      } as never),
    );
    await (
      input.client as {
        session: { promptAsync: (a: unknown) => Promise<unknown> };
      }
    ).session.promptAsync({
      path: { id: 'ses_1' },
      body: { parts: [{ type: 'text', text: 'fallback replay' }] },
      modelSwitch: 'required',
    });
    expect(seq).toHaveLength(1);
    expect(seq[0].m).toBe('prompt');
    expect(seq[0].i).toMatchObject({
      sessionID: 'ses_1',
      delivery: 'steer',
      text: 'fallback replay',
    });
  });

  test('mixed fallback replays (user parts + internal reminder) stay on session.prompt with files', async () => {
    // Regression for the greptile P1 on #1158: foreground-fallback appends
    // an internal-initiator reminder part to the user's real replay parts.
    // An ANY-part gate routed the whole mixed body through
    // session.synthetic — dropping the file attachments (the synthetic
    // branch forwards text only) and skipping user-input persistence.
    // Only PURELY internal bodies may take the synthetic route.
    const seq: Array<{ m: string; i: unknown }> = [];
    const input = buildPluginInput(
      makeCtx({
        switchModel: async () => {},
        prompt: async (i: unknown) => {
          seq.push({ m: 'prompt', i });
          return {};
        },
        synthetic: async (i: unknown) => {
          seq.push({ m: 'synthetic', i });
          return {};
        },
      } as never),
    );
    await (
      input.client as {
        session: {
          promptAsync: (
            a: Record<string, unknown> & {
              delivery?: 'steer' | 'queue';
              modelSwitch?: 'required';
            },
          ) => Promise<unknown>;
        };
      }
    ).session.promptAsync({
      path: { id: 'ses_1' },
      body: {
        agent: 'orchestrator',
        model: { providerID: 'anthropic', modelID: 'claude-fallback' },
        parts: [
          { type: 'text', text: 'analyze this screenshot' },
          {
            type: 'file',
            url: 'file:///tmp/shot.png',
            mime: 'image/png',
          },
          createInternalAgentTextPart(
            "<system-reminder>\nThe previous model request failed and is being retried with a fallback model. Continue processing the user's original request above. Do not respond to this reminder.\n</system-reminder>",
          ),
        ],
      },
      modelSwitch: 'required',
    });
    expect(seq).toHaveLength(1);
    expect(seq[0].m).toBe('prompt');
    expect(seq[0].i).toMatchObject({
      sessionID: 'ses_1',
      delivery: 'steer',
      metadata: { 'oh-my-opencode-slim.internalInitiator': true },
    });
    expect((seq[0].i as { text: string }).text).toContain(
      'analyze this screenshot',
    );
    expect((seq[0].i as { files: unknown[] }).files).toHaveLength(1);
  });

  test('abort delegates to interrupt', async () => {
    const calls: unknown[] = [];
    const input = buildPluginInput(
      makeCtx({
        interrupt: async (i: unknown) => {
          calls.push(i);
          return { interrupted: true };
        },
      } as never),
    );
    await (
      input.client as {
        session: { abort: (a: unknown) => Promise<unknown> };
      }
    ).session.abort({ path: { id: 'ses_1' } });
    expect(calls).toEqual([{ sessionID: 'ses_1', continue: false }]);
  });

  test('get delegates to session.get and wraps into {data}', async () => {
    const calls: unknown[] = [];
    const input = buildPluginInput(
      makeCtx({
        get: async (i: { sessionID: string }) => {
          calls.push(i);
          return { id: 'ses_1', parentID: 'ses_0', title: 't' };
        },
      } as never),
    );
    const res = await (
      input.client as {
        session: {
          get: (a: unknown) => Promise<{ data: unknown }>;
        };
      }
    ).session.get({ path: { id: 'ses_1' }, query: { directory: '/proj' } });
    expect(calls).toEqual([{ sessionID: 'ses_1' }]);
    expect(res.data).toEqual({ id: 'ses_1', parentID: 'ses_0', title: 't' });
  });

  test('delete delegates to session.remove with the flat {sessionID}', async () => {
    const calls: unknown[] = [];
    const input = buildPluginInput(
      makeCtx({
        remove: async (i: { sessionID: string }) => {
          calls.push(i);
        },
      } as never),
    );
    await (
      input.client as {
        session: { delete: (a: unknown) => Promise<unknown> };
      }
    ).session.delete({ path: { id: 'ses_tmp' }, query: { directory: '/d' } });
    // The smartfetch secondary-model cleanup shape (path.id) must resolve
    // to the flat v2 {sessionID} — no temp-session leak.
    expect(calls).toEqual([{ sessionID: 'ses_tmp' }]);
  });

  test('delete without remove resolves with an honest log (no fake throw)', async () => {
    const input = buildPluginInput(makeCtx({}));
    await expect(
      (
        input.client as {
          session: { delete: (a: unknown) => Promise<unknown> };
        }
      ).session.delete({ path: { id: 'ses_tmp' } }),
    ).resolves.toBeUndefined();
  });

  test('list delegates to session.list and maps to the v1 {data} envelope', async () => {
    const calls: unknown[] = [];
    const input = buildPluginInput(
      makeCtx({
        list: async (i: unknown) => {
          calls.push(i);
          return {
            data: [
              {
                id: 'ses_1',
                parentID: 'ses_0',
                projectID: 'proj_1',
                title: 'Interview thing',
                time: { created: 1, updated: 2, idle: 3 },
                location: { directory: '/w/alpha' },
                agent: 'orchestrator',
              },
              { id: 'ses_2', time: { created: 5 } },
            ],
            cursor: {},
          };
        },
      } as never),
    );
    const res = await (
      input.client as {
        session: {
          list: (a: unknown) => Promise<{ data: unknown[] }>;
        };
      }
    ).session.list({ query: {} });
    expect(calls).toEqual([{}]);
    // v1-shape mapping the interview dashboard reads: directory (from v2
    // location.ref) + time.updated for the scan cutoff; identity fields
    // pass through, nothing fabricated.
    expect(res.data).toEqual([
      {
        id: 'ses_1',
        parentID: 'ses_0',
        projectID: 'proj_1',
        title: 'Interview thing',
        agent: 'orchestrator',
        directory: '/w/alpha',
        time: { created: 1, updated: 2, idle: 3 },
      },
      { id: 'ses_2', time: { created: 5 } },
    ]);
  });

  test('list maps terminal outcome for the wake scheduler children view', async () => {
    const input = buildPluginInput(
      makeCtx({
        list: async () => ({
          data: [
            {
              id: 'kid_active',
              parentID: 'ses_0',
              time: { updated: 10 },
              location: { directory: '/proj' },
            },
            {
              id: 'kid_done',
              parentID: 'ses_0',
              outcome: 'succeeded',
              time: { updated: 20 },
              location: { directory: '/proj' },
            },
          ],
        }),
      } as never),
    );
    const res = await (
      input.client as {
        session: { list: (a: unknown) => Promise<{ data: unknown[] }> };
      }
    ).session.list({ query: { parentID: 'ses_0' } });
    expect(res.data).toEqual([
      {
        id: 'kid_active',
        parentID: 'ses_0',
        directory: '/proj',
        time: { updated: 10 },
        // outcome intentionally absent until terminal transition
      },
      {
        id: 'kid_done',
        parentID: 'ses_0',
        outcome: 'succeeded',
        directory: '/proj',
        time: { updated: 20 },
      },
    ]);
  });

  test('list passes through directory and parentID filters (null → "null")', async () => {
    const calls: unknown[] = [];
    const input = buildPluginInput(
      makeCtx({
        list: async (i: unknown) => {
          calls.push(i);
          return { data: [] };
        },
      } as never),
    );
    const list = (
      input.client as {
        session: { list: (a: unknown) => Promise<{ data: unknown[] }> };
      }
    ).session.list;
    await list({ query: { directory: '/w' } });
    await list({ query: { parentID: 'ses_parent' } });
    await list({ query: { parentID: null } });
    await list({ query: { parentID: 'null' } });
    expect(calls).toEqual([
      { directory: '/w' },
      { parentID: 'ses_parent' },
      { parentID: 'null' }, // root-only sentinel on the wire
      { parentID: 'null' },
    ]);
  });

  test('list without session.list keeps the v1-parity empty page', async () => {
    const input = buildPluginInput(makeCtx({}));
    await expect(
      (
        input.client as {
          session: { list: (a: unknown) => Promise<{ data: unknown[] }> };
        }
      ).session.list({ query: {} }),
    ).resolves.toEqual({ data: [] });
  });

  test('unavailable methods fail explicitly, never fake success', async () => {
    const input = buildPluginInput(makeCtx({}));
    const session = (
      input.client as {
        session: {
          prompt: (a: unknown) => Promise<unknown>;
          promptAsync: (a: unknown) => Promise<unknown>;
        };
      }
    ).session;
    await expect(
      session.prompt({ path: { id: 's' }, body: { parts: [] } }),
    ).rejects.toThrow(/unavailable/i);
    await expect(
      session.promptAsync({ path: { id: 's' }, body: { parts: [] } }),
    ).rejects.toThrow(/unavailable/i);
  });

  test('omits session.status — a fake empty map could falsely terminalize running jobs', () => {
    // getRuntimeSessionStatusSnapshot treats "status is a function" as the
    // capability signal; an empty-but-valid map lets stop-confirmation
    // mark a still-running background job `stopped` after the grace.
    // Omission keeps the lookup failing → snapshot.error → the safe
    // markStatusUncertain branch.
    const input = buildPluginInput(makeCtx({}));
    const session = (input.client as { session: Record<string, unknown> })
      .session;
    expect('status' in session).toBe(false);
    expect(session.status).toBeUndefined();
  });

  test('hostFlavor, project, and directory come from location', () => {
    const input = buildPluginInput(makeCtx({}));
    expect(input.hostFlavor).toBe('v2');
    expect(input.project).toEqual({ id: 'proj_1', directory: '/proj' });
    expect(input.directory).toBe('/proj');
    expect(input.worktree).toBe('/proj');
    expect(input.serverUrl).toBeUndefined();
  });

  test('location falls back to cwd with a global project', () => {
    const ctx = makeCtx({});
    delete (ctx as { location?: unknown }).location;
    const input = buildPluginInput(ctx);
    expect(input.directory).toBe(process.cwd());
    expect(input.project).toEqual({
      id: 'global',
      directory: process.cwd(),
    });
  });

  test('preserves the Phase 1 generateText channel', async () => {
    const generateText = async (prompt: string) => ({ text: prompt });
    const input = buildPluginInput(makeCtx({}), { generateText });
    const channel = (
      input as {
        experimental_v2?: {
          generateText?: (p: string) => Promise<{ text: string }>;
        };
      }
    ).experimental_v2?.generateText;
    expect(typeof channel).toBe('function');
    expect(await channel?.('ping')).toEqual({ text: 'ping' });
  });

  test('omits experimental_v2 entirely without extras', () => {
    const input = buildPluginInput(makeCtx({}));
    expect('experimental_v2' in (input as Record<string, unknown>)).toBe(false);
  });
});

describe('v2 client shim promptAsync model-switch hardening (#1125)', () => {
  function makePromptAsync(overrides?: Partial<V2Context['session']>) {
    const input = buildPluginInput(makeCtx(overrides));
    return (
      input.client as {
        session: {
          promptAsync: (
            a: Record<string, unknown> & {
              delivery?: 'steer' | 'queue';
              modelSwitch?: 'required';
              modelVariant?: string;
            },
          ) => Promise<unknown>;
        };
      }
    ).session.promptAsync;
  }

  test('confirmed switch resolves with switched:true over the ack record', async () => {
    const seq: Array<{ m: string; i: unknown }> = [];
    const promptAsync = makePromptAsync({
      switchModel: async (i: unknown) => {
        seq.push({ m: 'switchModel', i });
      },
      prompt: async (i: unknown) => {
        seq.push({ m: 'prompt', i });
        return { data: { id: 'inbox_1' } };
      },
    } as never);
    const res = await promptAsync({
      path: { id: 'ses_1' },
      body: {
        model: { providerID: 'anthropic', modelID: 'claude-x' },
        parts: [{ type: 'text', text: 'retry me' }],
      },
    });
    expect(seq).toHaveLength(2);
    // The ack payload passes through untouched; `switched` is additive.
    expect(res).toEqual({ data: { id: 'inbox_1' }, switched: true });
  });

  test('switchModel failure degrades: prompt still delivered, switched:false', async () => {
    const seq: Array<{ m: string; i: unknown }> = [];
    const promptAsync = makePromptAsync({
      switchModel: async () => {
        seq.push({ m: 'switchModel', i: undefined });
        throw new Error('model not available on host');
      },
      prompt: async (i: unknown) => {
        seq.push({ m: 'prompt', i });
        return { data: { id: 'inbox_1' } };
      },
    } as never);
    const res = await promptAsync({
      path: { id: 'ses_1' },
      body: {
        model: { providerID: 'anthropic', modelID: 'claude-x' },
        parts: [{ type: 'text', text: 'retry me' }],
      },
      modelSwitch: 'required',
    });
    // The prompt delivery is the load-bearing action: the failed switch
    // must NOT reject the call (that would abort the fallback chain as a
    // bogus "busy session") — the prompt is steered on the current model.
    expect(seq.map((e) => e.m)).toEqual(['switchModel', 'prompt']);
    expect(seq[1]).toMatchObject({
      m: 'prompt',
      i: { sessionID: 'ses_1', delivery: 'steer' },
    });
    expect(res).toEqual({ data: { id: 'inbox_1' }, switched: false });
  });

  test('modelSwitch required + host without switchModel → typed throw, no prompt', async () => {
    const prompts: unknown[] = [];
    const promptAsync = makePromptAsync({
      prompt: async (i: unknown) => {
        prompts.push(i);
        return {};
      },
    } as never);
    let caught: unknown;
    try {
      await promptAsync({
        path: { id: 'ses_1' },
        body: {
          model: { providerID: 'anthropic', modelID: 'claude-x' },
          parts: [{ type: 'text', text: 'retry me' }],
        },
        modelSwitch: 'required',
      });
    } catch (err) {
      caught = err;
    }
    // No silent same-model steering: the caller's logs must reflect that
    // the fallback target model could not be applied.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('V2SwitchModelUnavailableError');
    expect((caught as Error).message).toBe(
      '[v2] host provides no session.switchModel; cannot switch model for fallback prompt',
    );
    expect(prompts).toHaveLength(0);
  });

  test('modelSwitch absent + model requested keeps the steering degrade (wake pin regression guard)', async () => {
    // orchestrator-wake passes the session's CURRENT model as a pin; a
    // host without switchModel must keep steering (logged) — a blanket
    // throw would suppress every wake on such hosts.
    const prompts: Array<Record<string, unknown>> = [];
    const promptAsync = makePromptAsync({
      prompt: async (i: Record<string, unknown>) => {
        prompts.push(i);
        return {};
      },
    } as never);
    const res = await promptAsync({
      path: { id: 'ses_1' },
      body: {
        agent: 'orchestrator',
        model: { providerID: 'test', modelID: 'model-a' },
        parts: [{ type: 'text', text: 'wake reminder' }],
      },
      delivery: 'queue',
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.delivery).toBe('queue');
    expect((res as { switched: boolean }).switched).toBe(false);
  });

  test('promptAsync merges modelVariant into the switchModel model ref', async () => {
    const seq: Array<{ m: string; i: unknown }> = [];
    const promptAsync = makePromptAsync({
      switchModel: async (i: unknown) => {
        seq.push({ m: 'switchModel', i });
      },
      prompt: async (i: unknown) => {
        seq.push({ m: 'prompt', i });
        return {};
      },
    } as never);
    await promptAsync({
      path: { id: 'ses_1' },
      body: {
        agent: 'orchestrator',
        model: { providerID: 'test', modelID: 'model-a' },
        parts: [{ type: 'text', text: 'wake reminder' }],
      },
      delivery: 'queue',
      modelVariant: 'max',
    });
    expect(seq).toHaveLength(2);
    const switchCall = seq[0] as { i: { model: unknown } };
    expect(switchCall.i.model).toEqual({
      id: 'model-a',
      providerID: 'test',
      variant: 'max',
    });
  });

  test('promptAsync without modelVariant keeps the switchModel ref variant-free', async () => {
    const seq: Array<{ m: string; i: unknown }> = [];
    const promptAsync = makePromptAsync({
      switchModel: async (i: unknown) => {
        seq.push({ m: 'switchModel', i });
      },
      prompt: async (i: unknown) => {
        seq.push({ m: 'prompt', i });
        return {};
      },
    } as never);
    await promptAsync({
      path: { id: 'ses_1' },
      body: {
        model: { providerID: 'test', modelID: 'model-a' },
        parts: [{ type: 'text', text: 'retry me' }],
      },
    });
    const switchCall = seq[0] as { i: { model: Record<string, unknown> } };
    const model = switchCall.i.model;
    expect(model).toEqual({ id: 'model-a', providerID: 'test' });
    expect(Object.hasOwn(model, 'variant')).toBe(false);
  });

  test('promptAsync modelVariant without a body model does not switch models', async () => {
    const seq: Array<{ m: string; i: unknown }> = [];
    const promptAsync = makePromptAsync({
      switchModel: async (i: unknown) => {
        seq.push({ m: 'switchModel', i });
      },
      prompt: async (i: unknown) => {
        seq.push({ m: 'prompt', i });
        return {};
      },
    } as never);
    await promptAsync({
      path: { id: 'ses_1' },
      body: { parts: [{ type: 'text', text: 'plain steer' }] },
      modelVariant: 'max',
    });
    expect(seq.map((e) => e.m)).toEqual(['prompt']);
  });
});

describe('v2 client shim foreground-fallback integration', () => {
  test('replay → switchModel → steer prompt → interrupt flow', async () => {
    const seq: Array<{ m: string; i: unknown }> = [];
    const ctx = makeCtx({
      switchModel: async (i: unknown) => {
        seq.push({ m: 'switchModel', i });
      },
      prompt: async (i: unknown) => {
        seq.push({ m: 'prompt', i });
        return {};
      },
      interrupt: async (i: unknown) => {
        seq.push({ m: 'interrupt', i });
        return { interrupted: true };
      },
      context: async () => [
        {
          id: 'msg_1',
          role: 'user',
          content: [{ type: 'text', text: 'Fix the failing build' }],
        },
        {
          id: 'msg_2',
          role: 'assistant',
          content: [{ type: 'text', text: 'on it' }],
        },
      ],
    } as never);
    const input = buildPluginInput(ctx);
    const session = (
      input.client as {
        session: {
          messages: (a: unknown) => Promise<{ data: unknown[] }>;
          promptAsync: (a: unknown) => Promise<unknown>;
          abort: (a: unknown) => Promise<unknown>;
        };
      }
    ).session;

    // Step 1 of the fallback flow: fetch the transcript and locate the last
    // replayable user message using the real pipeline helpers.
    const result = await session.messages({ path: { id: 'ses_1' } });
    const lastUser = [...(result.data ?? [])]
      .reverse()
      .find(isReplayableUserMessage);
    expect(lastUser).toBeDefined();
    if (!lastUser) throw new Error('expected a replayable user message');
    const replayParts = partsFromReplayMessage(lastUser) as Array<{
      type: 'text';
      text: string;
    }>;
    expect(replayParts).toEqual([
      { type: 'text', text: 'Fix the failing build' },
    ]);

    // Step 2: re-submit with the fallback model exactly like
    // foreground-fallback does (replay parts + synthetic reminder).
    await session.promptAsync({
      path: { id: 'ses_1' },
      body: {
        parts: [
          ...replayParts,
          createInternalAgentTextPart(
            'The previous model request failed and is being retried.',
          ),
        ],
        model: { providerID: 'anthropic', modelID: 'claude-fallback' },
        agent: 'orchestrator',
      },
    });

    // v2 semantics: switchModel first (v1 {providerID, modelID} → v2
    // {id, providerID}), then a non-blocking steer prompt carrying both the
    // original user text and the synthetic reminder.
    expect(seq[0]).toMatchObject({
      m: 'switchModel',
      i: {
        sessionID: 'ses_1',
        model: { id: 'claude-fallback', providerID: 'anthropic' },
      },
    });
    expect(seq[1]).toMatchObject({
      m: 'prompt',
      i: { sessionID: 'ses_1', delivery: 'steer' },
    });
    expect((seq[1].i as { text: string }).text).toContain(
      'Fix the failing build',
    );
    expect((seq[1].i as { text: string }).text).toContain(
      'The previous model request failed',
    );

    // Step 3: abort maps to interrupt with continue:false.
    await session.abort({ path: { id: 'ses_1' } });
    expect(seq[2]).toEqual({
      m: 'interrupt',
      i: { sessionID: 'ses_1', continue: false },
    });
  });

  test('mapped transcript messages satisfy the v1 message-parts shape', async () => {
    const ctx = makeCtx({
      context: async () => [
        {
          id: 'msg_1',
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'reasoning', text: 'inner' },
          ],
        },
      ],
    } as never);
    const input = buildPluginInput(ctx);
    const result = await (
      input.client as {
        session: {
          messages: (a: unknown) => Promise<{ data: unknown[] }>;
        };
      }
    ).session.messages({ sessionID: 'ses_1' });

    // v1 SDK shape consumed by isUserMessageWithParts-based helpers.
    expect(result.data).toEqual([
      {
        info: { id: 'msg_1', role: 'user' },
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'reasoning', text: 'inner' },
        ],
      },
    ]);
    const message = result.data[0];
    expect(isReplayableUserMessage(message)).toBe(true);
    expect(partsFromReplayMessage(message as never)).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'reasoning', text: 'inner' },
    ]);
  });
});

describe('v2 client shim replay attachment preservation', () => {
  test('promptAsync maps image/file parts into v2 prompt files', async () => {
    const prompts: Array<Record<string, unknown>> = [];
    const input = buildPluginInput(
      makeCtx({
        prompt: async (i: Record<string, unknown>) => {
          prompts.push(i);
          return {};
        },
      } as never),
    );
    await (
      input.client as {
        session: { promptAsync: (a: unknown) => Promise<unknown> };
      }
    ).session.promptAsync({
      path: { id: 'ses_1' },
      body: {
        parts: [
          { type: 'text', text: 'analyze this' },
          {
            type: 'image',
            url: 'data:image/png;base64,AAAA',
            filename: 'shot.png',
          },
          { type: 'file', url: 'file:///proj/report.pdf' },
          { type: 'reasoning', text: 'not user-visible' },
        ],
      },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.text).toContain('analyze this');
    expect(prompts[0]?.files).toEqual([
      { uri: 'data:image/png;base64,AAAA', name: 'shot.png' },
      { uri: 'file:///proj/report.pdf' },
    ]);
  });

  test('non-text parts without uri are dropped and logged, prompt proceeds', async () => {
    const prompts: Array<Record<string, unknown>> = [];
    const input = buildPluginInput(
      makeCtx({
        prompt: async (i: Record<string, unknown>) => {
          prompts.push(i);
          return {};
        },
      } as never),
    );
    await (
      input.client as {
        session: { promptAsync: (a: unknown) => Promise<unknown> };
      }
    ).session.promptAsync({
      path: { id: 'ses_1' },
      body: {
        parts: [
          { type: 'text', text: 'retry me' },
          { type: 'image', mime: 'image/png' },
        ],
      },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.text).toBe('retry me');
    expect(prompts[0]?.files).toBeUndefined();
  });

  test('prompt translation carries files too', async () => {
    const prompts: Array<Record<string, unknown>> = [];
    const input = buildPluginInput(
      makeCtx({
        prompt: async (i: Record<string, unknown>) => {
          prompts.push(i);
          return {};
        },
      } as never),
    );
    await (
      input.client as {
        session: { prompt: (a: unknown) => Promise<unknown> };
      }
    ).session.prompt({
      path: { id: 'ses_1' },
      body: {
        parts: [
          { type: 'text', text: 'look' },
          { type: 'image', url: 'https://example.com/x.png' },
        ],
      },
    });
    expect(prompts[0]?.files).toEqual([{ uri: 'https://example.com/x.png' }]);
  });
});

describe('v2 client shim degradation notices (one-time per process)', () => {
  test('list/remove unavailability logs exactly one warning each, never per call', async () => {
    // Log-file assertions run in a subprocess: other test files
    // mock.module the logger globally in shared-process runs, so the
    // real logger (and its file sink) is only observable with a pristine
    // module registry (same approach as the runtime-status
    // reconciliation disable-notice test). The subprocess also gives the
    // shim's module-level one-time guards a fresh process — exactly the
    // "per plugin process" contract under test.
    const logDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'omos-client-shim-log-'),
    );
    const workerSource = `
      const { buildPluginInput } = await import(
        process.env.SHIM_MODULE_URL
      );
      const { initLogger, flushLoggerForTesting } = await import(
        process.env.LOGGER_MODULE_URL
      );
      const { readFileSync } = await import('node:fs');
      initLogger('client-shim-degradation');
      // Stock v2 plugin session domain: no list, no remove.
      const input = buildPluginInput({ session: {} });
      const session = input.client.session;
      for (let index = 0; index < 3; index += 1) {
        await session.list({ query: {} });
        await session.delete({ path: { id: 'ses_tmp' } });
      }
      await flushLoggerForTesting();
      const contents = readFileSync(process.env.LOG_FILE_PATH, 'utf8');
      const lines = contents.split('\\n');
      console.log(
        JSON.stringify({
          listWarnings: lines.filter((line) =>
            line.includes('session.list unavailable'),
          ).length,
          removeWarnings: lines.filter((line) =>
            line.includes('session.remove unavailable'),
          ).length,
        }),
      );
    `;
    const proc = Bun.spawn([process.execPath, '-e', workerSource], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        OPENCODE_LOG_DIR: logDir,
        SHIM_MODULE_URL: pathToFileURL(
          path.join(import.meta.dir, 'client-shim.ts'),
        ).href,
        LOGGER_MODULE_URL: pathToFileURL(
          path.join(import.meta.dir, '../utils/logger.ts'),
        ).href,
        LOG_FILE_PATH: path.join(
          logDir,
          'oh-my-opencode-slim.client-shim-degradation.log',
        ),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    await fs.rm(logDir, { recursive: true, force: true });
    if (exitCode !== 0) {
      console.error(stderr);
      expect(exitCode).toBe(0);
    }
    const counts = JSON.parse(stdout.trim()) as {
      listWarnings: number;
      removeWarnings: number;
    };
    // Three calls each, exactly one deterministic notice per capability.
    expect(counts.listWarnings).toBe(1);
    expect(counts.removeWarnings).toBe(1);
  });
});
