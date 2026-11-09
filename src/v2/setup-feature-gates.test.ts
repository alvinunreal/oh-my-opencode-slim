/**
 * Cold-gate coverage for the v2 setup master switches:
 *
 * - `interview.enabled: false` → no bridge instance (no `/interview` command
 *   marker registered, no per-event bridge work, no context-hook dispatch).
 * - V2 native defaults → no job ledger/KV; native keeps preset routing and
 *   the paired background-first rewrite, while off leaves delegation untouched.
 * - `liveConfigRefresh: false` → no config-file watcher, while the one-shot
 *   startup profile seed and explicit `refreshProfiles` still function.
 * - `sidebar: false` → no server-side sidebar state write on finalization.
 *
 * Every switch defaults to true; the baseline behavior assertions live in
 * setup.e2e.test.ts / hot-refresh.test.ts. The harness here deliberately
 * reuses the real `loadPluginConfig` path (a written config file) so the
 * gates are proven end-to-end against the loader, not a stub.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as configWatch from './config-watch';
import { SUBAGENT_BACKGROUND_DEFAULT_DESCRIPTION } from './delegation';
import { sessionPresetRpc } from './preset-rpc';
import { createV2Setup } from './setup';
import type {
  V2Context,
  V2SessionContextEvent,
  V2SessionPresetRpcHandlers,
} from './types';

/** Mock v2 context capturing the registrations the gates must suppress. */
function makeCtx(
  projectDir: string,
  storage: V2Context['storage'] = {
    get: async () => undefined,
    set: async () => {},
    remove: async () => {},
    scan: async () => ({ entries: [] }),
  },
) {
  const commandAdds: Array<{ name: string }> = [];
  const toolUpdates: Array<{ id: string; description?: unknown }> = [];
  const beforeHooks: Array<(event: never) => Promise<void>> = [];
  const subagentTools: Array<Record<string, unknown>> = [];
  const hooks: string[] = [];
  const skillCallbacks = new Set<(draft: unknown) => void>();
  const contextHooks: Array<(event: never) => Promise<void>> = [];
  const storageCalls = { get: 0, set: 0, remove: 0, scan: 0 };
  const rpcHandlers: Array<Record<string, unknown>> = [];
  const countedStorage = storage
    ? {
        get: async (key: string) => {
          storageCalls.get += 1;
          return storage.get(key);
        },
        set: async (key: string, value: unknown) => {
          storageCalls.set += 1;
          await storage.set(key, value);
        },
        remove: async (key: string) => {
          storageCalls.remove += 1;
          await storage.remove(key);
        },
        scan: async (options: {
          prefix: string;
          after?: string;
          limit?: number;
        }) => {
          storageCalls.scan += 1;
          return storage.scan(options);
        },
      }
    : undefined;
  const reg = (label: string) => ({
    dispose: () => hooks.push(`dispose:${label}`),
  });
  const ctx = {
    app: { name: 'opencode', version: 'v2-feature-gates' },
    options: {},
    storage: countedStorage,
    location: {
      directory: projectDir,
      project: {
        id: 'proj_gates',
        directory: projectDir,
        canonical: projectDir,
      },
    },
    agent: {
      transform: async (cb: (draft: unknown) => void) => {
        cb({
          list: () => [],
          get: () => undefined,
          default: () => {},
          update: (_id: string, fn: (agent: unknown) => void) => {
            commandAdds.length;
            fn({});
          },
          remove: () => {},
        });
        return reg('agent.transform');
      },
      reload: async () => ({}),
      list: async () => [],
    },
    tool: {
      transform: async (cb: (draft: unknown) => void) => {
        // One live `subagent` tool per replay so `update` and `get` observe
        // the same object: the setup reads the description back after the
        // rewrite to arm its background-default flip.
        const subagentTool: Record<string, unknown> = {
          description: 'native',
          execute: async () => ({}),
        };
        subagentTools.push(subagentTool);
        cb({
          // The native subagent executor is what the wrapper(s) wrap; record
          // each update plus the description the rewrite left behind, so the
          // native description/default pair stays observable.
          update: (id: string, update: (tool: unknown) => void) => {
            const tool = id === 'subagent' ? subagentTool : {};
            update(tool);
            toolUpdates.push({
              id,
              description: (tool as { description?: unknown }).description,
            });
          },
          get: (id: string) => (id === 'subagent' ? subagentTool : undefined),
          add: () => {},
        });
        return reg('tool.transform');
      },
      hook: async (name: string, cb?: (event: never) => Promise<void>) => {
        hooks.push(`tool:${name}`);
        if (name === 'execute.before' && typeof cb === 'function') {
          beforeHooks.push(cb);
        }
        return reg(`tool.hook:${name}`);
      },
    },
    command: {
      transform: async (cb: (draft: unknown) => void) => {
        cb({
          add: (definition: Record<string, unknown>) => {
            commandAdds.push({ name: definition.name as string });
          },
        });
        return reg('command.transform');
      },
      list: async () => [],
    },
    skill: {
      transform: async (cb: (draft: unknown) => void) => {
        skillCallbacks.add(cb);
        return {
          dispose: () => {
            skillCallbacks.delete(cb);
          },
        };
      },
      list: async () => [],
      reload: async () => {},
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        directory: projectDir,
        agent: 'orchestrator',
      }),
      hook: async (name: string, cb: (event: never) => Promise<void>) => {
        hooks.push(`session:${name}`);
        if (name === 'context') contextHooks.push(cb);
        return reg(`session.hook:${name}`);
      },
    },
    mcp: {
      transform: async (cb: (draft: unknown) => void) => {
        cb({
          list: () => [],
          get: () => undefined,
          set: () => {},
          update: () => {},
          remove: () => {},
        });
        return reg('mcp.transform');
      },
      reload: async () => {},
    },
    event: {
      // Synchronously-exhausted stream: the pump registers but no events
      // are ever delivered, so per-event bridge work is observable only
      // through the registrations above.
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
          return: () => Promise.resolve({ value: undefined, done: true }),
        }),
      }),
    },
    generate: {
      text: async (input: { prompt: string }) => ({
        text: `generated:${input.prompt}`,
      }),
    },
    rpc: {
      register: async (
        _definition: unknown,
        handlers: Record<string, unknown>,
      ) => {
        rpcHandlers.push(handlers);
        return reg('rpc.register');
      },
    },
  } as unknown as V2Context;

  return {
    ctx,
    commandAdds,
    toolUpdates,
    beforeHooks,
    subagentTools,
    hooks,
    contextHooks,
    storageCalls,
    rpcHandlers,
  };
}

const INTERVIEW_MARKER =
  '<omos-interview-command>do it</omos-interview-command>';

/** Native preset routing keeps the paired background-first description. */
function expectNativeWrap(
  updates: Array<{ id: string; description?: unknown }>,
) {
  const subagent = updates.filter((u) => u.id === 'subagent');
  expect(subagent.length).toBeGreaterThan(0);
  expect(
    subagent.every(
      (u) => u.description === SUBAGENT_BACKGROUND_DEFAULT_DESCRIPTION,
    ),
  ).toBe(true);
}

/** A v2 delegation the `execute.before` bridge must admit (or reject). */
function delegationEvent() {
  return {
    tool: 'subagent',
    sessionID: 'ses_gate_parent',
    agent: 'orchestrator',
    messageID: 'msg_gate',
    id: 'call_gate_delegate',
    input: { agent: 'explorer', description: 'probe', prompt: 'Work' },
  };
}

describe('v2 setup feature gates', () => {
  let originalEnv: typeof process.env;
  let fixtureRoot: string;
  let projectDir: string;

  const writeProjectConfig = async (content: Record<string, unknown>) => {
    await mkdir(path.join(projectDir, '.opencode'), { recursive: true });
    await Bun.write(
      path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify(content),
    );
  };

  beforeEach(async () => {
    originalEnv = { ...process.env };
    fixtureRoot = await mkdtemp(path.join(tmpdir(), 'omo-v2-gates-'));
    projectDir = path.join(fixtureRoot, 'project');
    await writeProjectConfig({ companion: { enabled: false } });
    process.env.OPENCODE_CONFIG_DIR = path.join(fixtureRoot, 'config');
    process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, 'xdg-config');
    process.env.XDG_DATA_HOME = path.join(fixtureRoot, 'xdg-data');
    process.env.XDG_CACHE_HOME = path.join(fixtureRoot, 'xdg-cache');
    process.env.OPENCODE_LOG_DIR = path.join(fixtureRoot, 'logs');
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  test('interview disabled: no command marker, no context dispatch', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      interview: { enabled: false },
    });
    const { ctx, commandAdds, contextHooks } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(commandAdds.map((c) => c.name)).not.toContain('interview');
      expect(commandAdds.map((c) => c.name)).toContain('deepwork');

      // The context hook stays registered (system/messages transforms and
      // generic command markers are unrelated to the interview), but the
      // interview seam must be a no-op: a trailing marker passes through
      // untouched instead of being rewritten into interview state.
      expect(contextHooks).toHaveLength(1);
      const trailing = {
        id: 'ses_gate',
        role: 'user',
        content: [{ type: 'text', text: INTERVIEW_MARKER }],
      };
      await contextHooks[0]?.({
        sessionID: 'ses_gate',
        agent: 'oracle',
        model: {},
        system: [],
        tools: {},
        messages: [trailing],
      } as unknown as V2SessionContextEvent);
      expect(trailing.content).toEqual([
        { type: 'text', text: INTERVIEW_MARKER },
      ]);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('lifecycle disabled: no persistence and no structured-launch wrapper', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      backgroundJobs: { mode: 'off' },
    });
    const { ctx, toolUpdates } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(toolUpdates.filter((tool) => tool.id === 'subagent')).toEqual([]);
      // No persisted board state was seeded for this project directory.
      const stateDir = path.join(
        fixtureRoot,
        'xdg-data',
        'opencode',
        'plugins',
        'oh-my-opencode-slim',
        'storage',
      );
      expect(fs.existsSync(stateDir)).toBe(false);
    } finally {
      await cleanup();
    }
  }, 20_000);

  for (const mode of ['native', 'off'] as const) {
    test(`backgroundJobs.mode "${mode}": no persistence and no structured-launch wrapper`, async () => {
      await writeProjectConfig({
        companion: { enabled: false },
        backgroundJobs: { mode },
      });
      const { ctx, toolUpdates, storageCalls } = makeCtx(projectDir);
      const cleanup = await createV2Setup()(ctx);
      try {
        expect(storageCalls).toEqual({ get: 0, set: 0, remove: 0, scan: 0 });
        if (mode === 'native') expectNativeWrap(toolUpdates);
        else
          expect(toolUpdates.filter((tool) => tool.id === 'subagent')).toEqual(
            [],
          );
        const stateDir = path.join(
          fixtureRoot,
          'xdg-data',
          'opencode',
          'plugins',
          'oh-my-opencode-slim',
          'storage',
        );
        expect(fs.existsSync(stateDir)).toBe(false);
      } finally {
        await cleanup();
      }
    }, 20_000);
  }

  // Regression: the bridge's fail-closed guard requires the session-preset
  // wrapper that consumes its admission. Gating that wrapper with the managed
  // lifecycle left the guard armed in `native`/`off`, so every `subagent` call
  // was rejected with 'Native subagent session preset wrapper unavailable'.
  for (const [label, backgroundJobs] of [
    ['mode "native"', { mode: 'native' }],
    ['mode "off"', { mode: 'off' }],
  ] as const) {
    test(`lifecycle off (${label}): delegation is not rejected by the preset guard`, async () => {
      await writeProjectConfig({
        companion: { enabled: false },
        backgroundJobs: backgroundJobs as Record<string, unknown>,
      });
      const { ctx, beforeHooks } = makeCtx(projectDir);
      const cleanup = await createV2Setup()(ctx);
      try {
        const hook = beforeHooks[0];
        if (!hook) throw new Error('tool:execute.before not captured');
        await expect(hook(delegationEvent() as never)).resolves.toBeUndefined();
      } finally {
        await cleanup();
      }
    }, 20_000);
  }

  // Regression: a continuation (`sessionID` without `agent`) must reach the
  // host. The preset wrapper consumes an admission for EVERY call, so the
  // bridge must capture one for resumes too, not only for `agent` launches.
  for (const [label, backgroundJobs] of [
    ['mode "native"', { mode: 'native' }],
    ['mode "off"', { mode: 'off' }],
  ] as const) {
    test(`${label}: a resume without agent runs the wrapped executor`, async () => {
      await writeProjectConfig({
        companion: { enabled: false },
        backgroundJobs: backgroundJobs as Record<string, unknown>,
      });
      const { ctx, beforeHooks, subagentTools } = makeCtx(projectDir);
      const cleanup = await createV2Setup()(ctx);
      try {
        const hook = beforeHooks[0];
        const subagent = subagentTools.at(-1);
        if (!hook || !subagent) throw new Error('subagent wiring not captured');
        const event = {
          ...delegationEvent(),
          id: 'call_gate_resume',
          input: { sessionID: 'ses_gate_child', prompt: 'Continue' },
        };
        await hook(event as never);
        const execute = subagent.execute as (
          input: unknown,
          context: unknown,
        ) => Promise<unknown>;
        await expect(
          execute(event.input, {
            sessionID: event.sessionID,
            id: event.id,
            signal: new AbortController().signal,
            progress: async () => {},
          }),
        ).resolves.toEqual({});
      } finally {
        await cleanup();
      }
    }, 20_000);
  }

  test('off constructs no preset RPC, server command, or storage access', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      backgroundJobs: { mode: 'off' },
    });
    const { ctx, rpcHandlers, commandAdds, storageCalls } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(rpcHandlers).toEqual([]);
      expect(commandAdds.map((entry) => entry.name)).not.toContain('preset');
      expect(storageCalls).toEqual({ get: 0, set: 0, remove: 0, scan: 0 });
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('explicit managed mode fails before registrations or storage reads', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      backgroundJobs: { mode: 'managed' },
    });
    const { ctx, hooks, commandAdds, toolUpdates, storageCalls } =
      makeCtx(projectDir);
    await expect(createV2Setup()(ctx)).rejects.toThrow(/managed/i);
    expect(hooks).toEqual([]);
    expect(commandAdds).toEqual([]);
    expect(toolUpdates).toEqual([]);
    expect(storageCalls).toEqual({ get: 0, set: 0, remove: 0, scan: 0 });
  });

  test.each([
    { concurrency: {} },
    { wallClockTimeoutMs: 0 },
    { maxSessionsPerAgent: 2 },
    { stopConfirmationMs: 5_000 },
  ])(
    'retired V2 limit %j refuses setup before storage or registrations',
    async (limit) => {
      await writeProjectConfig({
        companion: { enabled: false },
        backgroundJobs: { mode: 'native', ...limit },
      });
      const { ctx, hooks, commandAdds, toolUpdates, storageCalls } =
        makeCtx(projectDir);

      await expect(createV2Setup()(ctx)).rejects.toThrow(
        `Unsupported backgroundJobs.${Object.keys(limit)[0]}`,
      );
      expect(hooks).toEqual([]);
      expect(commandAdds).toEqual([]);
      expect(toolUpdates).toEqual([]);
      expect(storageCalls).toEqual({ get: 0, set: 0, remove: 0, scan: 0 });
    },
  );

  test('native default keeps the paired background-first description', async () => {
    const { ctx, toolUpdates } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      const flipped = toolUpdates.filter(
        (u) =>
          u.id === 'subagent' &&
          u.description === SUBAGENT_BACKGROUND_DEFAULT_DESCRIPTION,
      );
      expect(flipped.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('liveConfigRefresh disabled: no watcher, but seed and explicit preset refresh work', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      liveConfigRefresh: false,
      preset: 'cheap',
      presets: {
        cheap: { explorer: { model: 'openai/gpt-5-mini' } },
        strong: { explorer: { model: 'anthropic/claude-sonnet-4-5' } },
      },
    });
    const factory = configWatch.watchPluginConfigFiles;
    const watcherFactory = spyOn(
      configWatch,
      'watchPluginConfigFiles',
    ).mockImplementation(((options: configWatch.WatchPluginConfigOptions) => {
      return factory(options);
    }) as never);
    const values = new Map<string, unknown>();
    let writeFailure: Error | undefined;
    const { ctx, rpcHandlers } = makeCtx(projectDir, {
      get: async (key) => values.get(key),
      set: async (key, value) => {
        if (writeFailure) throw writeFailure;
        values.set(key, value);
      },
      remove: async (key) => {
        values.delete(key);
      },
      scan: async () => ({ entries: [] }),
    });
    if (ctx.location) ctx.location.workspaceID = 'workspace-gates';
    const createCalls: unknown[] = [];
    ctx.session.create = async (input) => {
      createCalls.push(input);
      return {
        id:
          createCalls.length === 1 ? 'ses_created_bound' : 'ses_created_failed',
      };
    };
    ctx.session.prompt = async () => {
      throw new Error('createBound must not prompt');
    };
    ctx.session.switchModel = ctx.session.switchAgent = async () => {
      throw new Error('createBound must keep the native root selection');
    };
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(watcherFactory).not.toHaveBeenCalled();

      // The unconditional one-shot refresh seeds the selected profile even
      // with filesystem watching disabled.
      const { readTuiSnapshot } = await import('../tui-state');
      expect(readTuiSnapshot(projectDir).agentModels.explorer).toBe(
        'openai/gpt-5-mini',
      );

      // The explicit /preset application uses the RPC's named refresh path,
      // which must still resolve against the current config without a watcher.
      const handlers = rpcHandlers[0];
      expect(handlers).toBeDefined();
      const apply = handlers?.apply as (
        input: { sessionID: string; presetName: string },
        context: { signal: AbortSignal },
      ) => Promise<{ presetName: string }>;
      const applied = await apply(
        { sessionID: 'ses_preset_off', presetName: 'strong' },
        { signal: new AbortController().signal },
      );
      expect(applied.presetName).toBe('strong');
      await expect(
        apply(
          { sessionID: 'ses_preset_missing', presetName: 'missing' },
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow('Unknown preset: missing');
      const createBound = (handlers as unknown as V2SessionPresetRpcHandlers)
        .createBound;
      const errorFactory = mock<Parameters<typeof createBound>[1]['error']>(
        (type, message, data) => ({ type, message, data }),
      );
      const callContext = {
        signal: new AbortController().signal,
        error: errorFactory,
      };
      const bound = await createBound({ presetName: 'strong' }, callContext);
      expect(bound).toMatchObject({
        sessionID: 'ses_created_bound',
        status: 'bound',
        presetName: 'strong',
        affects: 'future-children-only',
        team: { agentModels: { explorer: 'anthropic/claude-sonnet-4-5' } },
      });
      expect(createCalls).toEqual([
        { location: { directory: projectDir, workspaceID: 'workspace-gates' } },
      ]);
      expect(values.get('session-preset/v1/ses_created_bound')).toMatchObject({
        schemaVersion: 1,
        bundle: { presetName: 'strong' },
      });
      expect(
        await (handlers as unknown as V2SessionPresetRpcHandlers).read(
          { sessionID: bound.sessionID },
          { signal: new AbortController().signal },
        ),
      ).toEqual(bound);
      expect(errorFactory).not.toHaveBeenCalled();
      const missing = createBound({ presetName: 'missing' }, callContext);
      await expect(missing).rejects.toEqual({
        type: 'create_failed',
        message: 'Unknown preset: missing',
        data: null,
      });
      await expect(missing).rejects.toBe(errorFactory.mock.results[0].value);
      expect(createCalls).toHaveLength(1);
      writeFailure = new Error('KV unavailable');
      const failed = createBound({ presetName: 'strong' }, callContext);
      const message =
        'Created session ses_created_failed, but preset binding failed. Open it and use Apply to bind "strong".';
      await expect(failed).rejects.toEqual({
        type: 'create_failed',
        message,
        data: null,
      });
      expect(errorFactory).toHaveBeenLastCalledWith(
        'create_failed',
        message,
        null,
      );
      await expect(failed).rejects.toBe(errorFactory.mock.results[1].value);
      expect(
        sessionPresetRpc.methods.createBound.errors.create_failed.parse(null),
      ).toBeNull();
      expect(createCalls).toHaveLength(2);
      expect(values.has('session-preset/v1/ses_created_failed')).toBe(false);
      expect(watcherFactory).not.toHaveBeenCalled();
    } finally {
      await cleanup();
      watcherFactory.mockRestore();
    }
  }, 20_000);

  test('sidebar disabled: finalization writes no display names', async () => {
    await writeProjectConfig({
      companion: { enabled: false },
      sidebar: false,
      agents: { explorer: { model: 'openai/gpt-5-mini' } },
    });
    const { ctx } = makeCtx(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      // Supply a live agent draft so finalization runs at all: with the
      // sidebar switch on (baseline) this writes display names for every
      // registered agent; off, no tui-state write happens.
      const { readTuiSnapshot } = await import('../tui-state');
      expect(readTuiSnapshot(projectDir).agentModels).toEqual({});
    } finally {
      await cleanup();
    }
  }, 20_000);
});
