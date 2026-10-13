import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Hooks } from '@opencode-ai/plugin';
import { OhMyOpenCodeLite } from '../index';
import { MarketplaceStore } from '../marketplace/store';
import { readTuiSnapshot } from '../tui-state';
import { makeTestEnv, type TestEnv } from './test-fixtures';

const DEEPSEEK_CHEAP = {
  explorer: {
    model: 'opencode-go/deepseek-v4.1-flash',
    temperature: 0.2,
    options: { thinking: { type: 'enabled' } },
  },
};
const SONNET_STRONG = {
  explorer: { model: 'anthropic/claude-sonnet-4-5', variant: 'thinking' },
};
/** Both presets present; only the selected `preset` key differs. */
const withPreset = (preset: string) => ({
  preset,
  presets: { cheap: DEEPSEEK_CHEAP, strong: SONNET_STRONG },
});
const CHEAP_DEEPSEEK = {
  preset: 'cheap',
  presets: {
    cheap: { explorer: { model: 'opencode-go/deepseek-v4.1-flash' } },
  },
};

/** Live sidebar projections for the fixture project dir. */
const sidebarModels = () => readTuiSnapshot(env.projectDir).agentModels;

let env: TestEnv;

beforeEach(() => {
  env = makeTestEnv('omos-v2cr');
});

afterEach(() => {
  env.restore();
});

type ProfilesHook = (options?: { allowInvalidFallback?: boolean }) => Promise<
  | {
      ok: true;
      profiles: Record<
        string,
        {
          model?: { providerID: string; id: string; variant?: string };
          temperature?: number;
          providerOptions?: Record<string, unknown>;
          sidebarModel: string;
        }
      >;
      projection: {
        agentModels: Record<string, string>;
        agentVariants: Record<string, string>;
      };
    }
  | { ok: false; reason: string }
>;

function createPluginClient() {
  const noop = async () => ({});
  const session = new Proxy({}, { get: () => noop }) as Record<string, unknown>;
  return new Proxy(
    { app: { log: noop }, session },
    {
      get: (target, property) =>
        property in target
          ? target[property as keyof typeof target]
          : new Proxy({}, { get: () => noop }),
    },
  );
}

interface TestFactory {
  hooks: Hooks;
  refresh: ProfilesHook;
}

async function bootFactory(
  hostConfig: Record<string, unknown> = {},
): Promise<TestFactory> {
  const hooks = await OhMyOpenCodeLite({
    client: createPluginClient(),
    directory: env.projectDir,
    worktree: env.projectDir,
    serverUrl: new URL('http://127.0.0.1:4096'),
  } as never);
  // The host calls the config hook once at init; mirror that so the initial
  // registry/tui-state snapshot exists. `hostConfig.agent.<name>.model`
  // simulates a host-persisted /model pick (see index.test.ts).
  await hooks.config?.(hostConfig as never);
  const refresh = (hooks as unknown as { 'v2.refreshProfiles'?: ProfilesHook })[
    'v2.refreshProfiles'
  ];
  if (!refresh) throw new Error('v2.refreshProfiles hook missing');
  return { hooks, refresh };
}

/** Boots the factory, runs `body`, and always disposes the hooks. */
async function withFactory(
  body: (fac: TestFactory) => Promise<void>,
  hostConfig: Record<string, unknown> = {},
): Promise<void> {
  const fac = await bootFactory(hostConfig);
  try {
    await body(fac);
  } finally {
    await fac.hooks.dispose?.();
  }
}

describe('v2 profile refresh hook', () => {
  test('re-reads the config, resolves profiles, and rewrites the sidebar model entries', async () => {
    env.writeUserConfig(withPreset('cheap'));

    await withFactory(async ({ refresh }) => {
      expect(sidebarModels().explorer).toBe('opencode-go/deepseek-v4.1-flash');

      // Preset manager Save & Apply rewrites the file; the refresh hook is
      // what the watcher / direct call runs afterwards.
      env.writeUserConfig(withPreset('strong'));
      const refreshed = await refresh();

      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok) throw new Error(refreshed.reason);
      expect(refreshed.profiles.explorer?.model).toEqual({
        providerID: 'anthropic',
        id: 'claude-sonnet-4-5',
        variant: 'thinking',
      });
      expect(refreshed.profiles.explorer?.sidebarModel).toBe(
        'anthropic/claude-sonnet-4-5',
      );
      expect(sidebarModels().explorer).toBe('anthropic/claude-sonnet-4-5');
      expect(readTuiSnapshot(env.projectDir).agentVariants.explorer).toBe(
        'thinking',
      );
    });
  });

  test('resolves temperature and provider options for captured profiles', async () => {
    env.writeUserConfig({
      preset: 'cheap',
      presets: {
        cheap: {
          explorer: {
            model: 'opencode-go/deepseek-v4.1-flash',
            temperature: 0.25,
            options: { thinking: { type: 'enabled', budgetTokens: 4096 } },
          },
        },
      },
    });

    await withFactory(async ({ refresh }) => {
      const refreshed = await refresh();
      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok) throw new Error(refreshed.reason);
      expect(refreshed.profiles.explorer?.temperature).toBe(0.25);
      expect(refreshed.profiles.explorer?.providerOptions).toEqual({
        thinking: { type: 'enabled', budgetTokens: 4096 },
      });
    });
  });

  test('picks up manual project-config edits', async () => {
    env.writeUserConfig({});
    env.writeProjectConfig({
      preset: 'project-local',
      presets: {
        'project-local': { oracle: { model: 'openai/gpt-5-mini' } },
      },
    });

    await withFactory(async ({ refresh }) => {
      expect(sidebarModels().oracle).toBe('openai/gpt-5-mini');

      env.writeProjectConfig({
        preset: 'project-local',
        presets: {
          'project-local': { oracle: { model: 'openai/o3' } },
        },
      });
      const refreshed = await refresh();

      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok) throw new Error(refreshed.reason);
      expect(refreshed.profiles.oracle?.model).toEqual({
        providerID: 'openai',
        id: 'o3',
      });
      expect(sidebarModels().oracle).toBe('openai/o3');
    });
  });

  test('keeps host opencode.json agent overrides across a refresh', async () => {
    env.writeUserConfig(CHEAP_DEEPSEEK);
    const hooks = await OhMyOpenCodeLite({
      client: createPluginClient(),
      directory: env.projectDir,
      worktree: env.projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    try {
      // The host layer wins the shallow merge (same as at init).
      await hooks.config?.({
        agent: { explorer: { model: 'anthropic/claude-sonnet-4-5' } },
      } as never);
      expect(sidebarModels().explorer).toBe('anthropic/claude-sonnet-4-5');

      const refresh = (
        hooks as unknown as { 'v2.refreshProfiles'?: ProfilesHook }
      )['v2.refreshProfiles'];
      const refreshed = await refresh?.();

      expect(refreshed?.ok).toBe(true);
      if (!refreshed?.ok) throw new Error(refreshed?.reason);
      expect(refreshed.profiles.explorer?.model).toEqual({
        providerID: 'anthropic',
        id: 'claude-sonnet-4-5',
      });
      expect(sidebarModels().explorer).toBe('anthropic/claude-sonnet-4-5');
    } finally {
      await hooks.dispose?.();
    }
  });

  test('does not rebuild agent definitions or mutate session-frozen surfaces', async () => {
    env.writeUserConfig({
      preset: 'cheap',
      presets: {
        cheap: {
          explorer: {
            model: 'opencode-go/deepseek-v4.1-flash',
            prompt: 'You are a custom explorer.',
            permission: { edit: 'deny' },
          },
        },
      },
    });

    await withFactory(async ({ hooks, refresh }) => {
      const beforeAgentDefs = JSON.stringify(hooks.agent?.explorer);
      env.writeUserConfig({
        preset: 'cheap',
        presets: {
          cheap: {
            explorer: {
              model: 'anthropic/claude-sonnet-4-5',
              prompt: 'You are a DIFFERENT explorer.',
              permission: { edit: 'allow' },
            },
          },
        },
      });
      await refresh();

      // Prompt/permission surfaces stay frozen: the refresh only resolves
      // the inference profile (the v2 adapter never re-registers agents).
      expect(JSON.stringify(hooks.agent?.explorer)).toBe(beforeAgentDefs);
    });
  });

  test('malformed JSON is a hard refresh failure: last-good sidebar (and profiles) retained', async () => {
    env.writeUserConfig(CHEAP_DEEPSEEK);

    await withFactory(async ({ refresh }) => {
      expect(sidebarModels().explorer).toBe('opencode-go/deepseek-v4.1-flash');

      fs.writeFileSync(env.userConfigPath, '{ not json');
      const refreshed = await refresh();

      expect(refreshed.ok).toBe(false);
      if (refreshed.ok) throw new Error('expected a hard failure');
      expect(refreshed.reason).toContain('invalid-json');
      // No swap: the last-known-good sidebar model entry survives, and no
      // profiles were reported (the caller swaps only on ok).
      expect(sidebarModels().explorer).toBe('opencode-go/deepseek-v4.1-flash');
    });
  });

  test('startup can seed fallback profiles before any last-good table exists', async () => {
    fs.writeFileSync(env.userConfigPath, '{ not json');
    const { refresh } = await bootFactory();

    const result = await refresh({ allowInvalidFallback: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.profiles).length).toBeGreaterThan(0);
      expect(result.profiles.explorer).toBeDefined();
    }
  });

  test('schema-invalid config is a hard refresh failure: last-good sidebar retained', async () => {
    env.writeUserConfig(CHEAP_DEEPSEEK);

    await withFactory(async ({ refresh }) => {
      env.writeUserConfig({
        preset: 'cheap',
        presets: {
          // `temperature` must be a number: schema rejection.
          cheap: {
            explorer: { model: 'openai/gpt-5-mini', temperature: 'hot' },
          },
        },
      });
      const refreshed = await refresh();

      expect(refreshed.ok).toBe(false);
      if (refreshed.ok) throw new Error('expected a hard failure');
      expect(refreshed.reason).toContain('invalid-schema');
      expect(sidebarModels().explorer).toBe('opencode-go/deepseek-v4.1-flash');
    });
  });

  test('warning-only kinds (missing preset) do not fail the refresh', async () => {
    env.writeUserConfig(CHEAP_DEEPSEEK);

    await withFactory(async ({ refresh }) => {
      env.writeUserConfig({
        preset: 'ghost', // missing-preset warning, not a hard failure
        presets: {
          cheap: { explorer: { model: 'anthropic/claude-sonnet-4-5' } },
        },
      });
      const refreshed = await refresh();

      // The selected preset is missing (defaults apply) — a warning, not
      // malformed config.
      expect(refreshed.ok).toBe(true);
    });
  });

  test('refresh preserves marketplace agents in the sidebar roster', async () => {
    // Isolate the marketplace store for this test (test-isolation also sets
    // XDG_DATA_HOME, but a per-test root avoids cross-test package leakage).
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-v2cr-data-'));
    const priorDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;
    try {
      new MarketplaceStore({ pluginVersion: '3.0.2' }).install({
        manifest: {
          schemaVersion: 2,
          id: 'team/market',
          version: '1.0.0',
          displayName: 'market-agent',
          description: 'Marketplace agent for refresh regression',
          agentName: 'market-agent',
          prompt: 'Marketplace prompt',
          skills: [],
          mcps: [],
          tools: ['read'],
          author: { name: 'Test author' },
          tags: [],
          license: 'MIT',
          compatibility: { plugin: '>=1.0.0' },
          model: { source: 'explicit', candidates: ['provider/package'] },
          routing: {
            description: 'Marketplace lane',
            when: 'Marketplace task',
            keywords: ['marketplace'],
          },
        },
      } as never);
      env.writeUserConfig({
        preset: 'market',
        presets: { market: { marketplace: { agents: ['team/market'] } } },
      });

      await withFactory(async ({ refresh }) => {
        // Registry path wrote the full roster (core + marketplace).
        expect(sidebarModels()['market-agent']).toBeDefined();

        const refreshed = await refresh();
        expect(refreshed.ok).toBe(true);

        // The refresh must not clobber the marketplace roster entry.
        expect(sidebarModels()['market-agent']).toBeDefined();
      });
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// v2 chain refresh (#1527): profiles and fallback chains share one generation
// ---------------------------------------------------------------------------

type HooksWithV2 = Record<string, unknown>;

/** Drive one v2 retry-steering descent and return the switched-to model. */
const retryOnce = async (
  hooks: HooksWithV2,
  sessionID: string,
  agent: string,
  from: string,
): Promise<string | undefined> => {
  const [providerID, id] = from.split('/');
  let target: string | undefined;
  await (
    hooks as {
      'v2.session.retry'?: (
        event: unknown,
        switchModel: (
          sessionID: string,
          model: { providerID: string; id: string },
        ) => Promise<unknown>,
      ) => Promise<void>;
    }
  )['v2.session.retry']?.(
    {
      sessionID,
      agent,
      model: { providerID, id },
      error: { message: 'Rate limit exceeded' },
      decision: { retry: true },
    },
    async (_sessionID: string, model: { providerID: string; id: string }) => {
      target = `${model.providerID}/${model.id}`;
    },
  );
  return target;
};

const chainConfig = (chain: string[]) => ({
  agents: { orchestrator: { model: chain } },
  fallback: { enabled: true, maxRetries: 0 },
});

describe('v2 chain refresh', () => {
  test('refresh republishes chains: new children use the new chain, never removed models', async () => {
    env.writeUserConfig(chainConfig(['test/a', 'test/b', 'test/c']));
    await withFactory(async ({ hooks, refresh }) => {
      env.writeUserConfig(chainConfig(['test/x', 'test/y']));
      const refreshed = await refresh();
      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok) return;
      // Profile table serves the fresh head.
      expect(refreshed.profiles.orchestrator?.model).toMatchObject({
        providerID: 'test',
        id: 'x',
      });
      // The fresh child runs x; when x fails the descent continues on the
      // fresh chain (y) — never the removed a/b/c.
      expect(
        await retryOnce(
          hooks as HooksWithV2,
          'child-new',
          'orchestrator',
          'test/x',
        ),
      ).toBe('test/y');
    });
  });

  test('refresh while a child is registered keeps its original chain', async () => {
    env.writeUserConfig(chainConfig(['test/a', 'test/b', 'test/c']));
    await withFactory(async ({ hooks, refresh }) => {
      // Registration pin — the same call the v2 profile bridge makes when a
      // child's profile freezes.
      (hooks as HooksWithV2)['v2.pinSessionChains']?.('child-pinned');

      env.writeUserConfig(chainConfig(['test/x', 'test/y']));
      expect((await refresh()).ok).toBe(true);

      // The pinned child still descends its original chain...
      expect(
        await retryOnce(
          hooks as HooksWithV2,
          'child-pinned',
          'orchestrator',
          'test/a',
        ),
      ).toBe('test/b');
      // ...while a child registered after the refresh gets the new chain.
      (hooks as HooksWithV2)['v2.pinSessionChains']?.('child-new');
      expect(
        await retryOnce(
          hooks as HooksWithV2,
          'child-new',
          'orchestrator',
          'test/x',
        ),
      ).toBe('test/y');
    });
  });

  test('invalid config keeps the last-known-good chains', async () => {
    env.writeUserConfig(chainConfig(['test/a', 'test/b', 'test/c']));
    await withFactory(async ({ hooks, refresh }) => {
      fs.writeFileSync(env.userConfigPath, '{ not json');
      expect((await refresh()).ok).toBe(false);
      // Descent still follows the last-known-good generation.
      expect(
        await retryOnce(
          hooks as HooksWithV2,
          'child-keep',
          'orchestrator',
          'test/a',
        ),
      ).toBe('test/b');
    });
  });

  test('marketplace chains: user config wins, manifest chain survives refresh', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-v2cr-chain-'));
    const priorDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;
    try {
      const installPackage = (id: string, agentName: string) =>
        new MarketplaceStore({ pluginVersion: '3.0.2' }).install({
          manifest: {
            schemaVersion: 2,
            id,
            version: '1.0.0',
            displayName: agentName,
            description: `${agentName} for chain refresh regression`,
            agentName,
            prompt: 'Marketplace prompt',
            skills: [],
            mcps: [],
            tools: ['read'],
            author: { name: 'Test author' },
            tags: [],
            license: 'MIT',
            compatibility: { plugin: '>=1.0.0' },
            model: {
              source: 'explicit',
              candidates: ['pkg/one', 'pkg/two'],
            },
            routing: {
              description: 'Marketplace lane',
              when: 'Marketplace task',
              keywords: ['marketplace'],
            },
          },
        } as never);
      installPackage('team/market', 'market-agent');
      installPackage('team/pkg2', 'pkg-agent');
      env.writeUserConfig({
        preset: 'market',
        presets: {
          market: { marketplace: { agents: ['team/market', 'team/pkg2'] } },
        },
        agents: {
          orchestrator: { model: ['cfg/one', 'cfg/two'] },
          // Precedence: the user chain overrides the manifest candidates.
          'market-agent': { model: ['user/one', 'user/two'] },
        },
        fallback: { enabled: true, maxRetries: 0 },
      });

      await withFactory(async ({ hooks, refresh }) => {
        // User chain wins over the manifest candidates at startup.
        expect(
          await retryOnce(
            hooks as HooksWithV2,
            'm-user',
            'market-agent',
            'user/one',
          ),
        ).toBe('user/two');
        // Manifest chain serves the marketplace agent without user config.
        expect(
          await retryOnce(
            hooks as HooksWithV2,
            'm-pkg',
            'pkg-agent',
            'pkg/one',
          ),
        ).toBe('pkg/two');

        env.writeUserConfig({
          preset: 'market',
          presets: {
            market: { marketplace: { agents: ['team/market', 'team/pkg2'] } },
          },
          agents: {
            orchestrator: { model: ['cfg/one-b', 'cfg/two-b'] },
            'market-agent': { model: ['user/one', 'user/two'] },
          },
          fallback: { enabled: true, maxRetries: 0 },
        });
        expect((await refresh()).ok).toBe(true);

        // Merged result survives the refresh: the user chain still wins for
        // the configured marketplace agent, the manifest chain still serves
        // the unconfigured one, and the configured chain refreshed.
        expect(
          await retryOnce(
            hooks as HooksWithV2,
            'm-user-2',
            'market-agent',
            'user/one',
          ),
        ).toBe('user/two');
        expect(
          await retryOnce(
            hooks as HooksWithV2,
            'm-pkg-2',
            'pkg-agent',
            'pkg/one',
          ),
        ).toBe('pkg/two');
        expect(
          await retryOnce(
            hooks as HooksWithV2,
            'o-new',
            'orchestrator',
            'cfg/one-b',
          ),
        ).toBe('cfg/two-b');
      });
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('removed user override falls back to the manifest chain on refresh', async () => {
    // The startup modelCandidates merge user overrides. A refresh that
    // removes the override must serve the package's own manifest chain,
    // not republish the stale merged candidates.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-v2cr-ovr-'));
    const priorDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;
    try {
      new MarketplaceStore({ pluginVersion: '3.0.2' }).install({
        manifest: {
          schemaVersion: 2,
          id: 'team/ovr',
          version: '1.0.0',
          displayName: 'ovr-agent',
          description: 'Override removal chain refresh regression',
          agentName: 'ovr-agent',
          prompt: 'Marketplace prompt',
          skills: [],
          mcps: [],
          tools: ['read'],
          author: { name: 'Test author' },
          tags: [],
          license: 'MIT',
          compatibility: { plugin: '>=1.0.0' },
          model: {
            source: 'explicit',
            candidates: ['pkg/one', 'pkg/two'],
          },
          routing: {
            description: 'Marketplace lane',
            when: 'Marketplace task',
            keywords: ['marketplace'],
          },
        },
      } as never);
      env.writeUserConfig({
        preset: 'ovr',
        presets: { ovr: { marketplace: { agents: ['team/ovr'] } } },
        agents: { 'ovr-agent': { model: ['cfg/a', 'cfg/b'] } },
        fallback: { enabled: true, maxRetries: 0 },
      });

      await withFactory(async ({ hooks, refresh }) => {
        // The user override wins at startup.
        expect(
          await retryOnce(hooks as HooksWithV2, 'o-user', 'ovr-agent', 'cfg/a'),
        ).toBe('cfg/b');

        // Refresh with the override removed; the package stays selected.
        env.writeUserConfig({
          preset: 'ovr',
          presets: { ovr: { marketplace: { agents: ['team/ovr'] } } },
          fallback: { enabled: true, maxRetries: 0 },
        });
        expect((await refresh()).ok).toBe(true);

        // New children descend the manifest chain, never the removed
        // override.
        expect(
          await retryOnce(
            hooks as HooksWithV2,
            'o-manifest',
            'ovr-agent',
            'pkg/one',
          ),
        ).toBe('pkg/two');
      });
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('model-switch disables survive a refresh that changes the chain source', async () => {
    // A switched agent disabled at finalize must stay disabled even when a
    // refresh resolves its chain from a different source (config array →
    // manifest candidates). Guards the publish-time re-disable keying.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-v2cr-dis-'));
    const priorDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;
    try {
      new MarketplaceStore({ pluginVersion: '3.0.2' }).install({
        manifest: {
          schemaVersion: 2,
          id: 'team/pkgd',
          version: '1.0.0',
          displayName: 'pkg-agent',
          description: 'Disable-survival chain refresh regression',
          agentName: 'pkg-agent',
          prompt: 'Marketplace prompt',
          skills: [],
          mcps: [],
          tools: ['read'],
          author: { name: 'Test author' },
          tags: [],
          license: 'MIT',
          compatibility: { plugin: '>=1.0.0' },
          model: {
            source: 'explicit',
            candidates: ['pkg/one', 'pkg/two'],
          },
          routing: {
            description: 'Marketplace lane',
            when: 'Marketplace task',
            keywords: ['marketplace'],
          },
        },
      } as never);
      env.writeUserConfig({
        preset: 'disable',
        presets: { disable: { marketplace: { agents: ['team/pkgd'] } } },
        agents: {
          orchestrator: { model: ['cfg/one', 'cfg/two'] },
          'pkg-agent': { model: ['cfg/a', 'cfg/b'] },
        },
        fallback: { enabled: true, maxRetries: 0 },
      });

      // Host /model picks differ from both chain heads → both agents are
      // switched and their chains publish disabled.
      const hostConfig = {
        agent: {
          orchestrator: { model: 'host/orchestrator' },
          'pkg-agent': { model: 'user/live-pick' },
        },
      };
      await withFactory(async ({ hooks, refresh }) => {
        // Disabled at boot: no descent for either agent.
        expect(
          await retryOnce(
            hooks as HooksWithV2,
            'd-orch',
            'orchestrator',
            'cfg/one',
          ),
        ).toBeUndefined();
        expect(
          await retryOnce(hooks as HooksWithV2, 'd-pkg', 'pkg-agent', 'cfg/a'),
        ).toBeUndefined();

        // Refresh: pkg-agent's config array disappears — its chain now
        // resolves from the manifest candidates.
        env.writeUserConfig({
          preset: 'disable',
          presets: { disable: { marketplace: { agents: ['team/pkgd'] } } },
          agents: { orchestrator: { model: ['cfg/one', 'cfg/two'] } },
          fallback: { enabled: true, maxRetries: 0 },
        });
        expect((await refresh()).ok).toBe(true);

        // The disable survives the source change for both agents.
        expect(
          await retryOnce(
            hooks as HooksWithV2,
            'd-orch-2',
            'orchestrator',
            'cfg/one',
          ),
        ).toBeUndefined();
        expect(
          await retryOnce(
            hooks as HooksWithV2,
            'd-pkg-2',
            'pkg-agent',
            'pkg/one',
          ),
        ).toBeUndefined();
      }, hostConfig);
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
