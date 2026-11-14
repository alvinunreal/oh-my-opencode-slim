import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from 'bun:test';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import * as promiseTimers from 'node:timers/promises';
import type { RegistryFactoryBridge } from './agents/registry-bridge';
import { CompanionManager, stateFilePath } from './companion/manager';
import * as companionUpdater from './companion/updater';
import {
  COMPANION_MANIFEST,
  getCompanionBinaryPath,
  getCompanionTarget,
} from './companion/updater';
import { RuntimeConfig } from './config/runtime';
import { isTaggedPart } from './hooks/cache-safe-injection';
import { COUNCIL_INJECT_METADATA_KEY } from './hooks/council-inject';
import { ForegroundFallbackManager } from './hooks/foreground-fallback';
import { JSON_ERROR_REMINDER } from './hooks/json-error-recovery/hook';
import { PHASE_REMINDER_METADATA_KEY } from './hooks/phase-reminder';
import { LOOP_GUARD_WARNING } from './hooks/tool-loop-guard/hook';
import type { MessageWithParts } from './hooks/types';
import { BACKGROUND_JOB_BOARD_METADATA_KEY } from './hooks/volatile-message';
import { OhMyOpenCodeLite as plugin } from './index';
import { MarketplaceStore } from './marketplace/store';
import { createBuiltinMcps } from './mcp';
import {
  getTuiStatePath,
  readTuiSnapshot,
  snapshotSectionsEqual,
  updateSnapshot,
} from './tui-state';
import * as compat from './utils/compat';
import { createInternalAgentTextPart } from './utils/internal-initiator';
import * as loggerModule from './utils/logger';
import * as zip from './utils/zip-extractor';

function createPluginClient(
  noop: () => Promise<unknown>,
  abort?: (input: { path: { id: string } }) => Promise<unknown>,
  sessionOverrides: Record<string, unknown> = {},
) {
  const session = new Proxy(
    { ...sessionOverrides, ...(abort ? { abort } : {}) },
    {
      get(target, property) {
        if (property in target) {
          return target[property as keyof typeof target];
        }
        return noop;
      },
    },
  ) as Record<string, unknown>;
  return new Proxy(
    { app: { log: noop }, session },
    {
      get(target, property) {
        if (property in target) {
          return target[property as keyof typeof target];
        }
        return new Proxy({}, { get: () => noop });
      },
    },
  );
}

function _createHostTimerHarness() {
  let now = 0;
  let nextID = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const setTimeout = (callback: () => void, delay = 0) => {
    const id = ++nextID;
    timers.set(id, { at: now + delay, callback });
    return id;
  };
  const clearTimeout = (id: number) => timers.delete(id);
  const advanceTo = async (target: number) => {
    now = target;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort(([, left], [, right]) => left.at - right.at)[0];
      if (!due) break;
      timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
    }
  };

  return { now: () => now, setTimeout, clearTimeout, advanceTo };
}

describe('plugin env disable', () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('returns empty hooks without reading plugin context', async () => {
    process.env.OH_MY_OPENCODE_SLIM_DISABLE = '1';

    const ctx = new Proxy(
      {},
      {
        get(_target, property) {
          throw new Error(`disabled plugin read ctx.${String(property)}`);
        },
      },
    );

    const hooks = await plugin(ctx as Parameters<typeof plugin>[0]);

    expect(hooks).toEqual({});
    expect(hooks.config).toBeUndefined();
    expect(hooks.event).toBeUndefined();
    expect(hooks.tool).toBeUndefined();
  });
});

describe('plugin tool registration', () => {
  const ENV_KEYS = [
    'OH_MY_OPENCODE_SLIM_DISABLE',
    'OPENCODE_CONFIG_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'OPENCODE_LOG_DIR',
  ] as const;
  const originalEnv: Partial<
    Record<(typeof ENV_KEYS)[number], string | undefined>
  > = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
    }
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    const base = path.join(os.tmpdir(), 'oh-my-opencode-slim-hitl-empty');
    process.env.OPENCODE_CONFIG_DIR = `${base}-config`;
    process.env.XDG_CONFIG_HOME = `${base}-xdg`;
    process.env.XDG_DATA_HOME = `${base}-data`;
    process.env.XDG_CACHE_HOME = `${base}-cache`;
    process.env.OPENCODE_LOG_DIR = `${base}-logs`;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const orig = originalEnv[key];
      if (orig === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = orig;
      }
    }
  });

  test('v2 host leaves wait_for_user unregistered', async () => {
    const projectDir = await mkdtemp('/tmp/oh-my-opencode-slim-wfu-gate-');
    const noop = async () => ({});
    const session = new Proxy({}, { get: () => noop }) as Record<
      string,
      unknown
    >;
    const client = new Proxy(
      { app: { log: noop }, session },
      {
        get(target, property) {
          if (property in target) {
            return target[property as keyof typeof target];
          }
          return new Proxy({}, { get: () => noop });
        },
      },
    );
    const baseInput = {
      client,
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
      hostFlavor: 'v2',
    } as never;

    try {
      // v2 never registers wait_for_user (the native `question` tool covers
      // the blocking boundary) nor the v1-only amendment/resume tools that
      // native subagent(sessionID, prompt) replaces. The rest is intact.
      const hooks = await plugin(baseInput);
      expect(hooks.tool?.task_status).toBeDefined();
      expect(hooks.tool?.wait_for_user).toBeUndefined();
      expect(hooks.tool?.task_message).toBeUndefined();
      expect(hooks.tool?.task_revive).toBeUndefined();
      await hooks.dispose?.();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test('does not retain loop-guard state when search-path validation rejects', async () => {
    const projectDir = await mkdtemp('/tmp/oh-my-opencode-slim-search-hook-');
    const client = createPluginClient(async () => ({}));
    let hooks: Awaited<ReturnType<typeof plugin>> | undefined;

    try {
      hooks = await plugin({
        client,
        directory: projectDir,
        worktree: projectDir,
        serverUrl: new URL('http://127.0.0.1:4096'),
      } as never);

      const rejectedPath = path.join(projectDir, 'created-after-rejection');
      await expect(
        hooks['tool.execute.before']?.(
          { tool: 'glob', sessionID: 'search-loop', callID: 'rejected' },
          { args: { path: rejectedPath } },
        ),
      ).rejects.toThrow(/Search path does not exist/);

      // A host should not emit `after` after a rejected `before`, but this
      // simulates that stray completion to ensure it cannot poison tracking.
      await mkdir(rejectedPath);
      await hooks['tool.execute.after']?.(
        { tool: 'glob', sessionID: 'search-loop', callID: 'rejected' },
        { output: 'same', metadata: {} },
      );

      for (let i = 0; i < 4; i++) {
        const callID = `valid-${i}`;
        await hooks['tool.execute.before']?.(
          { tool: 'glob', sessionID: 'search-loop', callID },
          { args: { path: rejectedPath } },
        );
        await hooks['tool.execute.after']?.(
          { tool: 'glob', sessionID: 'search-loop', callID },
          { output: 'same', metadata: {} },
        );
      }

      await expect(
        hooks['tool.execute.before']?.(
          { tool: 'glob', sessionID: 'search-loop', callID: 'valid-4' },
          { args: { path: rejectedPath } },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await hooks?.dispose?.();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test('exposes an idempotent top-level dispose finalizer', async () => {
    const noop = async () => ({});
    const session = new Proxy({}, { get: () => noop }) as Record<
      string,
      unknown
    >;
    const client = new Proxy(
      { app: { log: noop }, session },
      {
        get(target, property) {
          if (property in target) {
            return target[property as keyof typeof target];
          }
          return new Proxy({}, { get: () => noop });
        },
      },
    );

    const hooks = await plugin({
      client,
      directory: '/private/tmp/oh-my-opencode-slim-dispose-project',
      worktree: '/private/tmp/oh-my-opencode-slim-dispose-project',
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    expect(hooks.dispose).toBeFunction();
    await hooks.dispose?.();
    await hooks.dispose?.();
  });

  test('status and reload report a disabled marketplace against the live registry', async () => {
    const originalEnv = { ...process.env };
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'marketplace-disabled-live-'),
    );
    const configDir = path.join(root, 'config');
    await mkdir(configDir, { recursive: true });
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_DATA_HOME: path.join(root, 'data'),
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    const configPath = path.join(configDir, 'oh-my-opencode-slim.json');
    const config = {
      preset: 'work',
      presets: { work: { marketplace: { agents: ['team/live'] } } },
    };
    await Bun.write(configPath, JSON.stringify(config));
    new MarketplaceStore({ pluginVersion: '3.2.0' }).install({
      manifest: {
        schemaVersion: 2,
        id: 'team/live',
        version: '1.0.0',
        displayName: 'Live',
        description: 'Live fixture',
        agentName: 'live-agent',
        prompt: 'Test.',
        skills: [],
        mcps: [],
        tools: ['read'],
        author: { name: 'Test' },
        tags: [],
        license: 'MIT',
        compatibility: { plugin: '*' },
        model: { source: 'session' },
        routing: { description: 'Live', when: 'Testing.', keywords: [] },
      } as never,
    });
    const hooks = await plugin({
      client: createPluginClient(async () => ({})),
      directory: root,
      worktree: root,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);
    try {
      await hooks.config?.({ agent: {} });
      const { marketplaceService } = (
        hooks as unknown as { registryBridge: RegistryFactoryBridge }
      ).registryBridge;
      expect(marketplaceService.status().reloadRequired).toBe(false);
      await Bun.write(
        configPath,
        JSON.stringify({ ...config, marketplace: { enabled: false } }),
      );
      expect(marketplaceService.status()).toMatchObject({
        desiredPackageIds: [],
        reloadRequired: true,
      });
      expect(marketplaceService.requestReload()).toMatchObject({
        desiredPackageIds: [],
        reloadRequired: true,
      });
    } finally {
      await hooks.dispose?.();
      process.env = originalEnv;
      await rm(root, { recursive: true, force: true });
    }
  });

  test('activates only marketplace packages selected by the resolved preset at first host finalization', async () => {
    const originalEnv = { ...process.env };
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'oh-my-opencode-slim-marketplace-finalize-'),
    );
    const configDir = path.join(root, 'config');
    const dataDir = path.join(root, 'data');
    await mkdir(configDir, { recursive: true });
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_DATA_HOME: dataDir,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    const packageManifest = (id: string, agentName: string) => ({
      schemaVersion: 2,
      id,
      version: '1.0.0',
      displayName: agentName,
      description: 'Selected package agent',
      agentName,
      prompt: 'Package prompt',
      skills: [],
      mcps: [],
      tools: ['read'],
      author: { name: 'Test author' },
      tags: [],
      license: 'MIT',
      compatibility: { plugin: '>=1.0.0' },
      model: {
        source: 'explicit',
        candidates: ['provider/package', 'provider/package-fallback'],
      },
      routing: {
        description: 'Package lane',
        when: 'Package task',
        keywords: ['package'],
      },
    });
    const store = new MarketplaceStore({ pluginVersion: '2.2.25' });
    store.install({
      manifest: packageManifest('team/selected', 'selected-agent') as never,
    });
    store.install({
      manifest: packageManifest('team/unselected', 'unselected-agent') as never,
    });
    await Bun.write(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'active',
        fallback: { enabled: true, maxRetries: 0 },
        agents: {
          'selected-agent': {
            displayName: 'SelectedVisible',
            model: 'owner/selected',
          },
        },
        presets: {
          active: { marketplace: { agents: ['team/selected'] } },
        },
      }),
    );
    const hooks = await plugin({
      client: createPluginClient(async () => ({})),
      directory: root,
      worktree: root,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);
    const hostConfig = {
      agent: {
        orchestrator: { displayName: 'Lead' },
        Lead: { prompt: 'Visible host orchestrator prompt' },
        'selected-agent': {
          model: 'provider/host-selected',
          variant: 'host-variant',
        },
      },
    };
    try {
      await expect(
        hooks.tool?.marketplace_inspect?.execute({ action: 'status' }, {
          agent: 'Lead',
        } as never),
      ).rejects.toThrow('until the agent registry is finalized');
      await hooks.config?.(hostConfig);
      const registryBridge = (
        hooks as unknown as {
          registryBridge: RegistryFactoryBridge;
        }
      ).registryBridge;
      const initialStatus = registryBridge.marketplaceService.status();
      expect(initialStatus.liveAvailable).toBe(true);
      expect(initialStatus.reloadRequired).toBe(false);
      await hooks.config?.(hostConfig);
      const replayStatus = registryBridge.marketplaceService.status();
      expect(replayStatus.reloadRequired).toBe(false);
      expect(replayStatus.diagnostics).not.toContain(
        'The current host agent snapshot is not trustworthy for desired marketplace status',
      );
      registryBridge.finalize(structuredClone(hostConfig) as never, {});
      expect(registryBridge.marketplaceService.status().reloadRequired).toBe(
        false,
      );
      await expect(
        hooks.tool?.marketplace_inspect?.execute({ action: 'status' }, {
          agent: 'Lead',
        } as never),
      ).resolves.toContain('"liveAvailable": true');
      await hooks.tool?.marketplace_manage?.execute(
        { action: 'enable', target: 'team/unselected' },
        { agent: 'orchestrator' } as never,
      );
      const persistedActivation = readFileSync(
        path.join(root, '.opencode', 'oh-my-opencode-slim.jsonc'),
        'utf8',
      );
      expect(persistedActivation).toContain('team/unselected');
      expect(
        readFileSync(path.join(configDir, 'oh-my-opencode-slim.json'), 'utf8'),
      ).not.toContain('team/unselected');
      expect(hostConfig.agent).not.toHaveProperty('unselected-agent');

      const localSkillDir = path.join(
        root,
        '.opencode',
        'skills',
        'local-skill',
      );
      await mkdir(localSkillDir, { recursive: true });
      await Bun.write(
        path.join(localSkillDir, 'SKILL.md'),
        '---\nname: local-skill\ndescription: Local skill fixture\n---\n',
      );
      await Bun.write(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({
          preset: 'active',
          fallback: { enabled: true, maxRetries: 0 },
          agents: {
            'selected-agent': {
              prompt: 'Changed prompt',
              displayName: 'ChangedVisible',
              model: 'owner/changed',
              permission: { read: 'deny' },
              skills: ['base-skill', 'removed-skill'],
              skills_add: ['added-skill'],
              skills_remove: ['removed-skill'],
              skills_include_local: true,
            },
          },
          presets: {
            active: { marketplace: { agents: ['team/selected'] } },
          },
        }),
      );
      expect(registryBridge.marketplaceService.status().reloadRequired).toBe(
        true,
      );
      await hooks.config?.({
        agent: {
          explorer: { model: 'provider/inherited-model-drift' },
          'selected-agent': {
            model: 'provider/host-override-drift',
            prompt: 'Host override drift',
            displayName: 'HostSelected',
          },
        },
      });
      expect(registryBridge.marketplaceService.status().reloadRequired).toBe(
        true,
      );
      expect(hostConfig.agent).toHaveProperty('selected-agent');
      expect(hostConfig.agent).not.toHaveProperty('unselected-agent');
      expect(hostConfig.agent).not.toHaveProperty('changed_baseline');
      const visiblePrompt = (
        hostConfig.agent as Record<string, { prompt?: string }>
      ).Lead?.prompt;
      expect(visiblePrompt).toContain('Visible host orchestrator prompt');
      expect(visiblePrompt).toContain('@SelectedVisible');
      expect(visiblePrompt).not.toContain('@unselected-agent');
      expect(visiblePrompt?.match(/<Marketplace agents>/g)).toHaveLength(1);
      await hooks['chat.message']?.(
        {
          sessionID: 'marketplace-system-transform',
          agent: 'orchestrator',
          model: { providerID: 'provider', modelID: 'main' },
        } as never,
        {} as never,
      );
      const system = [
        [
          'You are powered by the model named provider/main.',
          '<env>',
          '  Working directory: /tmp',
          '</env>',
        ].join('\n'),
      ];
      await hooks['experimental.chat.system.transform']?.(
        { sessionID: 'marketplace-system-transform' } as never,
        { system } as never,
      );
      expect(system.join('\n')).toContain('Visible host orchestrator prompt');
      expect(system.join('\n')).toContain('@SelectedVisible');
      expect(system.join('\n')).not.toContain('@unselected-agent');
      const switchModel = mock(async () => ({}));
      const retry = async (id: string) => {
        await hooks['v2.session.retry']?.(
          {
            sessionID: 'marketplace-fallback',
            agent: 'SelectedVisible',
            model: { providerID: 'provider', id },
            error: { message: 'rate limit exceeded' },
            decision: { retry: true },
          } as never,
          switchModel as never,
        );
      };
      await retry('host-selected');
      expect(switchModel).toHaveBeenNthCalledWith(1, 'marketplace-fallback', {
        providerID: 'provider',
        id: 'package',
      });
      await retry('package');
      expect(switchModel).toHaveBeenNthCalledWith(2, 'marketplace-fallback', {
        providerID: 'provider',
        id: 'package-fallback',
      });

      const generationB = await plugin({
        client: createPluginClient(async () => ({})),
        directory: root,
        worktree: root,
        serverUrl: new URL('http://127.0.0.1:4096'),
      } as never);
      await generationB.config?.({ agent: {} });
      const bridgeB = (
        generationB as unknown as {
          registryBridge: RegistryFactoryBridge;
        }
      ).registryBridge;
      expect(bridgeB.marketplaceService.status().reloadRequired).toBe(false);
      await generationB.dispose?.();
    } finally {
      await hooks.dispose?.();
      process.env = originalEnv;
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fresh desired projection uses newly enabled builtin MCPs', async () => {
    const originalEnv = { ...process.env };
    const root = await mkdtemp(
      '/tmp/oh-my-opencode-slim-marketplace-fresh-mcp-',
    );
    const configDir = path.join(root, 'config');
    await mkdir(configDir, { recursive: true });
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_DATA_HOME: path.join(root, 'data'),
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    const store = new MarketplaceStore({ pluginVersion: '2.2.25' });
    store.install({
      manifest: {
        schemaVersion: 2,
        id: 'team/requires-context7',
        version: '1.0.0',
        displayName: 'Requires Context7',
        description: 'Fresh MCP config fixture',
        agentName: 'requires-context7-agent',
        prompt: 'Use Context7.',
        skills: [],
        mcps: ['context7'],
        tools: ['read'],
        author: { name: 'Test author' },
        tags: [],
        license: 'MIT',
        compatibility: { plugin: '>=1.0.0' },
        model: { source: 'explicit', candidates: ['provider/package'] },
        routing: {
          description: 'MCP fixture',
          when: 'A Context7 test is needed.',
          keywords: ['context7'],
        },
      } as never,
    });
    const configPath = path.join(configDir, 'oh-my-opencode-slim.json');
    await Bun.write(
      configPath,
      JSON.stringify({
        preset: 'inactive',
        disabled_mcps: ['context7'],
        presets: {
          inactive: { marketplace: { agents: [] } },
          active: {
            marketplace: { agents: ['team/requires-context7'] },
          },
        },
      }),
    );
    const hooks = await plugin({
      client: createPluginClient(async () => ({})),
      directory: root,
      worktree: root,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);
    try {
      await hooks.config?.({ agent: {}, mcp: {} });
      const registryBridge = (
        hooks as unknown as { registryBridge: RegistryFactoryBridge }
      ).registryBridge;
      await Bun.write(
        configPath,
        JSON.stringify({
          preset: 'active',
          disabled_mcps: [],
          presets: {
            inactive: { marketplace: { agents: [] } },
            active: {
              marketplace: { agents: ['team/requires-context7'] },
            },
          },
        }),
      );

      const status = registryBridge.marketplaceService.status();
      expect(status.reloadRequired).toBe(true);
      expect(status.diagnostics).toEqual([]);
    } finally {
      await hooks.dispose?.();
      process.env = originalEnv;
      await rm(root, { recursive: true, force: true });
    }
  });

  test('user-defined MCP override wins and reconciles back when removed', async () => {
    const originalEnv = { ...process.env };
    const root = await mkdtemp('/tmp/oh-my-opencode-slim-mcp-override-');
    const configDir = path.join(root, 'config');
    await mkdir(configDir, { recursive: true });
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_DATA_HOME: path.join(root, 'data'),
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    await Bun.write(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'active',
        presets: { active: { marketplace: { agents: [] } } },
      }),
    );
    const hooks = await plugin({
      client: createPluginClient(async () => ({})),
      directory: root,
      worktree: root,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);
    try {
      // 1. The host config overrides a built-in key (issue #1290).
      const userGhGrep = {
        type: 'remote',
        url: 'https://user.example.com/mcp',
      };
      const hostConfig: Record<string, unknown> = {
        mcp: { gh_grep: userGhGrep },
      };
      await hooks.config?.(hostConfig);
      const merged = hostConfig.mcp as Record<string, unknown>;
      expect(merged.gh_grep).toEqual(userGhGrep);
      expect(merged.context7).toBeDefined();

      // 2. The live export drops the overridden built-in, keeps the rest.
      const exported = (hooks as unknown as { mcp: Record<string, unknown> })
        .mcp;
      expect(exported).not.toHaveProperty('gh_grep');
      expect(exported).toHaveProperty('context7');

      // 3. User removes the override in the same process: both the merged
      // config and the export must regain the built-in gh_grep. Delete-only
      // reconciliation left the export pruned forever here.
      const secondConfig: Record<string, unknown> = { mcp: {} };
      await hooks.config?.(secondConfig);
      const rebuilt = secondConfig.mcp as Record<string, unknown>;
      expect(rebuilt.gh_grep).toEqual(createBuiltinMcps().gh_grep);
      expect(rebuilt.gh_grep).not.toEqual(userGhGrep);
      expect(rebuilt.context7).toBeDefined();
      expect(exported).toHaveProperty('gh_grep');
      expect(exported.gh_grep).toEqual(createBuiltinMcps().gh_grep);
    } finally {
      await hooks.dispose?.();
      process.env = originalEnv;
      await rm(root, { recursive: true, force: true });
    }
  });

  test('config re-invocation with the same mutated object keeps built-ins', async () => {
    const originalEnv = { ...process.env };
    const root = await mkdtemp('/tmp/oh-my-opencode-slim-mcp-reinvoke-');
    const configDir = path.join(root, 'config');
    await mkdir(configDir, { recursive: true });
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_DATA_HOME: path.join(root, 'data'),
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    await Bun.write(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'active',
        presets: { active: { marketplace: { agents: [] } } },
      }),
    );
    const hooks = await plugin({
      client: createPluginClient(async () => ({})),
      directory: root,
      worktree: root,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);
    try {
      const userGhGrep = {
        type: 'remote',
        url: 'https://user.example.com/mcp',
      };
      const hostConfig: Record<string, unknown> = {
        mcp: { gh_grep: userGhGrep },
      };
      await hooks.config?.(hostConfig);
      const exportRef = (hooks as unknown as { mcp: Record<string, unknown> })
        .mcp;
      expect(exportRef).toHaveProperty('context7');
      expect(exportRef).not.toHaveProperty('gh_grep');

      // The host hands back the very object the first call mutated (its
      // `mcp` now holds the plugin-injected built-ins). Those must not be
      // re-read as user-defined entries and pruned from the live export.
      await hooks.config?.(hostConfig);
      const merged = hostConfig.mcp as Record<string, unknown>;
      expect(merged.context7).toBeDefined();
      expect(merged.gh_grep).toEqual(userGhGrep);
      expect((hooks as unknown as { mcp: Record<string, unknown> }).mcp).toBe(
        exportRef,
      );
      expect(exportRef).toHaveProperty('context7');
      expect(exportRef).not.toHaveProperty('gh_grep');
      expect(exportRef.context7).toEqual(createBuiltinMcps().context7);
    } finally {
      await hooks.dispose?.();
      process.env = originalEnv;
      await rm(root, { recursive: true, force: true });
    }
  });

  test('marketplace status follows the active runtime preset over disk and environment selection', async () => {
    const originalEnv = { ...process.env };
    const root = await mkdtemp(
      '/tmp/oh-my-opencode-slim-marketplace-runtime-preset-',
    );
    const configDir = path.join(root, 'config');
    const dataDir = path.join(root, 'data');
    await mkdir(configDir, { recursive: true });
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_DATA_HOME: dataDir,
      OH_MY_OPENCODE_SLIM_PRESET: 'disk',
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    const packageManifest = (id: string, agentName: string) => ({
      schemaVersion: 2,
      id,
      version: '1.0.0',
      displayName: agentName,
      description: 'Preset selection fixture',
      agentName,
      prompt: 'Preset fixture prompt',
      skills: [],
      mcps: [],
      tools: ['read'],
      author: { name: 'Test author' },
      tags: [],
      license: 'MIT',
      compatibility: { plugin: '>=1.0.0' },
      model: { source: 'explicit', candidates: ['provider/package'] },
      routing: {
        description: 'Preset package',
        when: 'A preset package is needed.',
        keywords: ['preset'],
      },
    });
    const pluginConfig = {
      preset: 'disk',
      presets: {
        disk: { marketplace: { agents: ['team/disk-preset'] } },
        runtime: { marketplace: { agents: ['team/runtime-preset'] } },
      },
    } as Parameters<typeof RuntimeConfig.init>[1];
    RuntimeConfig.reset(root);
    RuntimeConfig.init(root, pluginConfig, 'v2').setRuntimePreset('runtime');
    const store = new MarketplaceStore({ pluginVersion: '2.2.25' });
    store.install({
      manifest: packageManifest('team/disk-preset', 'disk-agent') as never,
    });
    store.install({
      manifest: packageManifest(
        'team/runtime-preset',
        'runtime-agent',
      ) as never,
    });
    await Bun.write(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify(pluginConfig),
    );
    const hooks = await plugin({
      client: createPluginClient(async () => ({})),
      directory: root,
      worktree: root,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);
    try {
      await hooks.config?.({ agent: {}, mcp: {} });
      const marketplaceService = (
        hooks as unknown as { registryBridge: RegistryFactoryBridge }
      ).registryBridge.marketplaceService;
      const status = marketplaceService.status();
      expect(status.desiredPackageIds).toEqual(['team/runtime-preset']);
      expect(status.livePackages?.map(({ id }) => id)).toEqual([
        'team/runtime-preset',
      ]);
      expect(status.reloadRequired).toBe(false);
      expect(marketplaceService.requestReload().reloadRequired).toBe(false);

      await Bun.write(
        path.join(configDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({
          preset: 'disk',
          presets: {
            disk: { marketplace: { agents: ['team/disk-preset'] } },
          },
        }),
      );
      const deletedOverrideStatus = marketplaceService.status();
      expect(deletedOverrideStatus.desiredPackageIds).toEqual([
        'team/disk-preset',
      ]);
      expect(deletedOverrideStatus.livePackages?.map(({ id }) => id)).toEqual([
        'team/runtime-preset',
      ]);
      expect(deletedOverrideStatus.reloadRequired).toBe(true);
      expect(marketplaceService.requestReload().reloadRequired).toBe(true);
    } finally {
      await hooks.dispose?.();
      RuntimeConfig.reset(root);
      process.env = originalEnv;
      await rm(root, { recursive: true, force: true });
    }
  });

  test('broken selected preset inheritance falls back to baseline agents at startup', async () => {
    const originalEnv = { ...process.env };
    const invalidPresetCases = [
      {
        selected: 'broken',
        presets: {
          broken: {
            extends: 'missing-parent',
            marketplace: { agents: ['team/selected'] },
          },
        },
      },
      {
        selected: 'first',
        presets: {
          first: {
            extends: 'second',
            marketplace: { agents: ['team/selected'] },
          },
          second: { extends: 'first' },
        },
      },
    ];
    const packageManifest = {
      schemaVersion: 2,
      id: 'team/selected',
      version: '1.0.0',
      displayName: 'Selected package',
      description: 'Must not activate from an invalid preset chain',
      agentName: 'selected-agent',
      prompt: 'Package prompt',
      skills: [],
      mcps: [],
      tools: ['read'],
      author: { name: 'Test author' },
      tags: [],
      license: 'MIT',
      compatibility: { plugin: '>=1.0.0' },
      model: { source: 'explicit', candidates: ['provider/package'] },
      routing: {
        description: 'Package lane',
        when: 'Package task',
        keywords: ['package'],
      },
    };
    try {
      for (const invalidPreset of invalidPresetCases) {
        const root = await mkdtemp(
          '/tmp/oh-my-opencode-slim-invalid-marketplace-preset-',
        );
        const configDir = path.join(root, 'config');
        await mkdir(configDir, { recursive: true });
        process.env = {
          ...originalEnv,
          OPENCODE_CONFIG_DIR: configDir,
          XDG_DATA_HOME: path.join(root, 'data'),
        };
        delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
        const store = new MarketplaceStore({ pluginVersion: '2.2.25' });
        store.install({ manifest: packageManifest as never });
        await Bun.write(
          path.join(configDir, 'oh-my-opencode-slim.json'),
          JSON.stringify({
            preset: invalidPreset.selected,
            presets: invalidPreset.presets,
          }),
        );
        const hooks = await plugin({
          client: createPluginClient(async () => ({})),
          directory: root,
          worktree: root,
          serverUrl: new URL('http://127.0.0.1:4096'),
        } as never);
        try {
          const hostConfig = { agent: {} as Record<string, unknown> };
          await hooks.config?.(hostConfig);
          expect(hostConfig.agent).toHaveProperty('explorer');
          expect(hostConfig.agent).not.toHaveProperty('selected-agent');
        } finally {
          await hooks.dispose?.();
          await rm(root, { recursive: true, force: true });
        }
      }
    } finally {
      process.env = originalEnv;
    }
  });
});

describe('plugin built-in agent disabling', () => {
  let originalEnv: typeof process.env;
  let projectDir: string;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    projectDir = await mkdtemp('/tmp/oh-my-opencode-slim-builtin-agents-');
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: projectDir,
      XDG_DATA_HOME: `${projectDir}/data`,
      XDG_CACHE_HOME: `${projectDir}/cache`,
      OPENCODE_LOG_DIR: `${projectDir}/logs`,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({ companion: { enabled: false } }),
    );
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(projectDir, { recursive: true, force: true });
  });

  const createHooks = () =>
    plugin({
      client: createPluginClient(async () => ({})),
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

  test('#1582 disables built-in subagents and stays idempotent on replay', async () => {
    const hooks = await createHooks();
    try {
      const hostConfig: Record<string, unknown> = { agent: {} };
      await hooks.config?.(hostConfig);
      const agent = hostConfig.agent as Record<string, unknown>;
      expect(agent.general).toEqual({ disable: true });
      expect(agent.explore).toEqual({ disable: true });

      // Re-invocation hands back the object the first call mutated: our
      // exact injected shape is re-asserted, not treated as user-owned.
      await hooks.config?.(hostConfig);
      const replayed = hostConfig.agent as Record<string, unknown>;
      expect(replayed.general).toEqual({ disable: true });
      expect(replayed.explore).toEqual({ disable: true });
    } finally {
      await hooks.dispose?.();
    }
  });

  test('#1582 leaves a user-declared built-in entry untouched', async () => {
    const hooks = await createHooks();
    try {
      const hostConfig: Record<string, unknown> = {
        agent: { general: { model: 'p/m' } },
      };
      await hooks.config?.(hostConfig);
      const agent = hostConfig.agent as Record<string, unknown>;
      expect(agent.general).toEqual({ model: 'p/m' });
      expect(agent.general).not.toHaveProperty('disable');
      expect(agent.explore).toEqual({ disable: true });
    } finally {
      await hooks.dispose?.();
    }
  });

  test('#1582 overrides an injected disable shape after a user edits the entry', async () => {
    const hooks = await createHooks();
    try {
      const hostConfig: Record<string, unknown> = { agent: {} };
      await hooks.config?.(hostConfig);
      // User edits the entry mid-session; the host hands the mutated object
      // back. Our shape must not out-stare the user's declaration.
      const agent = hostConfig.agent as Record<string, unknown>;
      agent.general = { model: 'p/new' };
      await hooks.config?.(hostConfig);
      expect(agent.general).toEqual({ model: 'p/new' });
      expect(agent.general).not.toHaveProperty('disable');
    } finally {
      await hooks.dispose?.();
    }
  });

  test('#1582 disables the host explore entry even with the plugin alias present', async () => {
    const hooks = await createHooks();
    try {
      // AGENT_ALIASES maps explore → explorer; the alias must never shadow
      // the host built-in's own key.
      const hostConfig: Record<string, unknown> = { agent: {} };
      await hooks.config?.(hostConfig);
      const agent = hostConfig.agent as Record<string, unknown>;
      expect(agent.explore).toEqual({ disable: true });
      expect(agent.explorer).not.toHaveProperty('disable');
    } finally {
      await hooks.dispose?.();
    }
  });
});

describe('plugin reload generation cleanup', () => {
  let originalEnv: typeof process.env;
  let projectDir: string;

  const createHooks = (pluginConfig: Record<string, unknown> = {}) =>
    plugin({
      client: createPluginClient(async () => ({})),
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
      ...pluginConfig,
    } as never);

  const reminderFixture = (
    sessionID: string,
  ): { messages: MessageWithParts[] } => ({
    messages: [
      {
        info: {
          id: `user-${sessionID}`,
          role: 'user',
          agent: 'orchestrator',
          sessionID,
        },
        parts: [{ type: 'text', text: 'Continue the task.' }],
      },
      {
        info: {
          id: `assistant-${sessionID}`,
          role: 'assistant',
          agent: 'orchestrator',
          sessionID,
        },
        parts: [{ type: 'text', text: 'Working on it.' }],
      },
      {
        info: {
          id: `user-followup-${sessionID}`,
          role: 'user',
          agent: 'orchestrator',
          sessionID,
        },
        parts: [{ type: 'text', text: 'Take the next step.' }],
      },
    ],
  });

  const registerOrchestrator = async (
    hooks: Awaited<ReturnType<typeof plugin>>,
    sessionID: string,
  ) => {
    await hooks['chat.message']?.(
      { sessionID, agent: 'orchestrator' } as never,
      {} as never,
    );
  };

  const transform = async (
    hooks: Awaited<ReturnType<typeof plugin>>,
    fixture: { messages: MessageWithParts[] },
  ) => {
    const output = structuredClone(fixture);
    await hooks['experimental.chat.messages.transform']?.(
      {} as never,
      output as never,
    );
    return output;
  };

  const readPluginLog = (): string => {
    try {
      return readdirSync(`${projectDir}/logs`)
        .filter(
          (f) => f.startsWith('oh-my-opencode-slim.') && f.endsWith('.log'),
        )
        .map((f) => readFileSync(`${projectDir}/logs/${f}`, 'utf8'))
        .join('');
    } catch {
      return '';
    }
  };

  /** Three-request sequence whose third entry is the field signature of a
   * mid-session prompt-cache bust: a previously cache-hitting session
   * reports zero cached tokens on a sizeable request. */
  const feedCacheBustSequence = async (
    hooks: Awaited<ReturnType<typeof plugin>>,
    sessionID: string,
  ) => {
    const bustEvent = (
      messageID: string,
      input: number,
      cacheRead: number,
    ) => ({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            role: 'assistant',
            sessionID,
            id: messageID,
            time: { completed: 1_700_000_000 },
            tokens: {
              input,
              output: 100,
              reasoning: 0,
              cache: { read: cacheRead, write: 0 },
            },
          },
        },
      },
    });
    await hooks.event?.(bustEvent('m1', 8000, 0) as never);
    await hooks.event?.(bustEvent('m2', 500, 9000) as never);
    await hooks.event?.(bustEvent('m3', 12000, 0) as never);
  };

  const taggedParts = (messages: MessageWithParts[], key: string) =>
    messages.flatMap((message) =>
      message.parts.filter((part) => isTaggedPart(part, key)),
    );
  const reminderParts = (messages: MessageWithParts[]) =>
    taggedParts(messages, PHASE_REMINDER_METADATA_KEY);
  const _boardParts = (messages: MessageWithParts[]) =>
    taggedParts(messages, BACKGROUND_JOB_BOARD_METADATA_KEY);

  beforeEach(async () => {
    originalEnv = { ...process.env };
    projectDir = await mkdtemp('/tmp/oh-my-opencode-slim-gens-');
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: projectDir,
      XDG_DATA_HOME: `${projectDir}/data`,
      XDG_CACHE_HOME: `${projectDir}/cache`,
      OPENCODE_LOG_DIR: `${projectDir}/logs`,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({ companion: { enabled: false } }),
    );
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(projectDir, { recursive: true, force: true });
  });

  test('file read leaves the composed reminder payload byte-identical', async () => {
    const hooks = await createHooks();
    const sessionID = 'read-reminder-session';
    const fixture = {
      messages: [
        {
          info: {
            id: 'user-1',
            role: 'user',
            agent: 'orchestrator',
            sessionID,
          },
          parts: [{ type: 'text', text: 'Read the project files.' }],
        },
      ],
    };

    try {
      await hooks['chat.message']?.(
        { sessionID, agent: 'orchestrator' } as never,
        {} as never,
      );
      const before = structuredClone(fixture);
      await hooks['experimental.chat.messages.transform']?.(
        {} as never,
        before as never,
      );

      await hooks['tool.execute.after']?.(
        { tool: 'read', sessionID } as never,
        { output: 'file contents' } as never,
      );
      const after = structuredClone(fixture);
      await hooks['experimental.chat.messages.transform']?.(
        {} as never,
        after as never,
      );

      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
      expect(
        after.messages
          .at(-1)
          ?.parts.filter(
            (part) =>
              'metadata' in part &&
              (part as { metadata?: Record<string, unknown> }).metadata?.[
                PHASE_REMINDER_METADATA_KEY
              ] === true,
          ),
      ).toHaveLength(1);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('messages transform leaves advertised skill text byte-identical', async () => {
    const hooks = await createHooks();
    const fixture = {
      messages: [
        {
          info: {
            id: 'skills-user-message',
            role: 'user',
            agent: 'explorer',
            sessionID: 'skills-advertisement-session',
          },
          parts: [
            {
              type: 'text',
              text: [
                'Please inspect these available skills.',
                '<available_skills>',
                '<skill><name>review-tools</name></skill>',
                '<skill><name>private-skill</name></skill>',
                '</available_skills>',
              ].join('\n'),
            },
          ],
        },
      ],
    };

    try {
      const before = JSON.stringify(fixture);
      const output = structuredClone(fixture);
      await hooks['experimental.chat.messages.transform']?.(
        { agent: 'explorer' } as never,
        output as never,
      );
      expect(JSON.stringify(output)).toBe(before);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('disabled_hooks phase-reminder leaves the payload untouched', async () => {
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: { enabled: false },
        disabled_hooks: ['phase-reminder'],
      }),
    );
    const hooks = await createHooks();
    const sessionID = 'disabled-reminder-session';
    try {
      await registerOrchestrator(hooks, sessionID);
      const output = await transform(hooks, reminderFixture(sessionID));
      expect(reminderParts(output.messages)).toHaveLength(0);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('disabled_hooks chat-headers keeps the hook unregistered', async () => {
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: { enabled: false },
        disabled_hooks: ['chat-headers'],
      }),
    );
    const disabled = await createHooks();
    try {
      expect(disabled['chat.headers']).toBeUndefined();
    } finally {
      await disabled.dispose?.();
    }

    // Control: the default config still registers the hook, so the
    // absence above is the gate and not a dead registration path.
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({ companion: { enabled: false } }),
    );
    const enabled = await createHooks();
    try {
      expect(typeof enabled['chat.headers']).toBe('function');
    } finally {
      await enabled.dispose?.();
    }
  });

  test('cache-monitor logs a bust warning on the default config', async () => {
    const hooks = await createHooks();
    try {
      await feedCacheBustSequence(hooks, 'control');
      await loggerModule.flushLoggerForTesting();
      expect(readPluginLog()).toContain('prompt-cache bust');
    } finally {
      await hooks.dispose?.();
    }
  });

  test('disabled_hooks cache-monitor stops the cache-bust watchdog', async () => {
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: { enabled: false },
        disabled_hooks: ['cache-monitor'],
      }),
    );
    const hooks = await createHooks();
    try {
      await feedCacheBustSequence(hooks, 'gated');
      await loggerModule.flushLoggerForTesting();
      expect(readPluginLog()).not.toContain('prompt-cache bust');
    } finally {
      await hooks.dispose?.();
    }
  });

  test('disabled_hooks tool guards stop intercepting tool calls entirely', async () => {
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: { enabled: false },
        disabled_hooks: [
          'json-error-recovery',
          'tool-loop-guard',
          'search-path-guard',
          'absolute-path-rescue',
          'apply-patch',
        ],
      }),
    );
    await Bun.write(`${projectDir}/sample.txt`, 'alpha\nbeta\ngamma\n');
    await mkdir(`${projectDir}/src`, { recursive: true });
    await Bun.write(`${projectDir}/src/app.ts`, 'export {};\n');
    const hooks = await createHooks();
    try {
      // apply-patch: the unrecoverable patch passes through untouched.
      const patchText =
        '*** Begin Patch\n*** Update File: sample.txt\n@@\n-missing\n+omega\n*** End Patch';
      const patchOutput = { args: { patchText } };
      await hooks['tool.execute.before']?.(
        {
          tool: 'apply_patch',
          sessionID: 'guards-off',
          callID: 'g-1',
        } as never,
        patchOutput as never,
      );
      expect(patchOutput.args.patchText).toBe(patchText);

      // absolute-path-rescue: the guessed path is left as written.
      const guessed = `/${path.basename(projectDir)}/src/app.ts`;
      const rescueOutput = { args: { filePath: guessed } };
      await hooks['tool.execute.before']?.(
        { tool: 'read', sessionID: 'guards-off', callID: 'g-2' } as never,
        rescueOutput as never,
      );
      expect(rescueOutput.args.filePath).toBe(guessed);

      // search-path-guard: grep on a missing path resolves instead of
      // rejecting.
      await expect(
        hooks['tool.execute.before']?.(
          { tool: 'grep', sessionID: 'guards-off', callID: 'g-3' } as never,
          {
            args: { path: `${projectDir}/does-not-exist/missing.txt` },
          } as never,
        ),
      ).resolves.toBeUndefined();

      // tool-loop-guard: three identical calls never append the warning.
      for (const callID of ['g-4', 'g-5', 'g-6']) {
        await hooks['tool.execute.before']?.(
          { tool: 'read', sessionID: 'loop-off', callID } as never,
          { args: { filePath: 'a.ts' } } as never,
        );
        const output = { output: '...file contents...', metadata: {} };
        await hooks['tool.execute.after']?.(
          { tool: 'read', sessionID: 'loop-off', callID } as never,
          output as never,
        );
        expect(output.output).toBe('...file contents...');
      }

      // json-error-recovery: the malformed output surfaces raw.
      const jsonOutput = {
        title: 'Tool Error',
        output: "JSON parse error: expected '}' in JSON body",
        metadata: {},
      };
      await hooks['tool.execute.after']?.(
        { tool: 'Edit', sessionID: 'guards-off', callID: 'g-7' } as never,
        jsonOutput as never,
      );
      expect(jsonOutput.output).toBe(
        "JSON parse error: expected '}' in JSON body",
      );
    } finally {
      await hooks.dispose?.();
    }
  });

  test('tool guards act on the default config (positive control)', async () => {
    await Bun.write(`${projectDir}/sample.txt`, 'alpha\nbeta\ngamma\n');
    await mkdir(`${projectDir}/src`, { recursive: true });
    await Bun.write(`${projectDir}/src/app.ts`, 'export {};\n');
    const hooks = await createHooks();
    try {
      // apply-patch rejects the unrecoverable patch.
      const patchText =
        '*** Begin Patch\n*** Update File: sample.txt\n@@\n-missing\n+omega\n*** End Patch';
      await expect(
        hooks['tool.execute.before']?.(
          {
            tool: 'apply_patch',
            sessionID: 'guards-on',
            callID: 'c-1',
          } as never,
          { args: { patchText } } as never,
        ),
      ).rejects.toThrow('patch verification failed');

      // absolute-path-rescue rewrites the guessed path to the existing
      // suffix.
      const rescueOutput = {
        args: { filePath: `/${path.basename(projectDir)}/src/app.ts` },
      };
      await hooks['tool.execute.before']?.(
        { tool: 'read', sessionID: 'guards-on', callID: 'c-2' } as never,
        rescueOutput as never,
      );
      expect(rescueOutput.args.filePath).toBe(`${projectDir}/src/app.ts`);

      // search-path-guard rejects grep on a missing path.
      await expect(
        hooks['tool.execute.before']?.(
          { tool: 'grep', sessionID: 'guards-on', callID: 'c-3' } as never,
          {
            args: { path: `${projectDir}/does-not-exist/missing.txt` },
          } as never,
        ),
      ).rejects.toThrow('Search path does not exist');

      // tool-loop-guard warns on the third identical call.
      let thirdOutput: { output: unknown } | undefined;
      for (const callID of ['c-4', 'c-5', 'c-6']) {
        await hooks['tool.execute.before']?.(
          { tool: 'read', sessionID: 'loop-on', callID } as never,
          { args: { filePath: 'a.ts' } } as never,
        );
        thirdOutput = { output: '...file contents...', metadata: {} };
        await hooks['tool.execute.after']?.(
          { tool: 'read', sessionID: 'loop-on', callID } as never,
          thirdOutput as never,
        );
      }
      expect(String(thirdOutput?.output)).toContain(LOOP_GUARD_WARNING);

      // json-error-recovery appends the reminder.
      const jsonOutput = {
        title: 'Tool Error',
        output: "JSON parse error: expected '}' in JSON body",
        metadata: {},
      };
      await hooks['tool.execute.after']?.(
        { tool: 'invalid', sessionID: 'guards-on', callID: 'c-7' } as never,
        jsonOutput as never,
      );
      expect(String(jsonOutput.output)).toContain(JSON_ERROR_REMINDER);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('a stale compaction mark cleared by the next user message leaves reminders intact', async () => {
    const hooks = await createHooks();
    const sessionID = 'stale-mark-session';
    try {
      await registerOrchestrator(hooks, sessionID);
      await hooks['experimental.session.compacting']?.(
        { sessionID },
        { context: [] },
      );
      // The compaction dies before its transform; the next ordinary user
      // turn arrives and must not lose its reminders.
      await hooks['chat.message']?.(
        { sessionID, agent: 'orchestrator' } as never,
        {} as never,
      );
      const after = await transform(hooks, reminderFixture(sessionID));
      expect(reminderParts(after.messages)).toHaveLength(1);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('companion startup does not gate plugin availability on a slow download', async () => {
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({ companion: { enabled: true } }),
    );
    const fetchOriginal = globalThis.fetch;
    const started = Promise.withResolvers<void>();
    const loaded = Promise.withResolvers<void>();
    let complete!: (response: Response) => void;
    let aborted = false;
    globalThis.fetch = ((_url, options) =>
      new Promise<Response>((resolve, reject) => {
        complete = resolve;
        options?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
        started.resolve();
      })) as typeof fetch;
    const originalLoad = CompanionManager.prototype.onLoad;
    const load = spyOn(CompanionManager.prototype, 'onLoad').mockImplementation(
      function (this: CompanionManager) {
        originalLoad.call(this);
        loaded.resolve();
      },
    );
    jest.useFakeTimers();
    let hooks: Awaited<ReturnType<typeof plugin>> | undefined;
    try {
      const initialization = createHooks();
      await started.promise;
      jest.advanceTimersByTime(3_001);
      hooks = await initialization;
      expect(aborted).toBe(false);
      complete(new Response('', { status: 503 }));
      await loaded.promise;
      expect(
        JSON.parse(readFileSync(stateFilePath(), 'utf8')).sessions,
      ).toHaveLength(1);
    } finally {
      complete?.(new Response('', { status: 503 }));
      await hooks?.dispose?.();
      load.mockRestore();
      globalThis.fetch = fetchOriginal;
      jest.useRealTimers();
    }
  });

  test('reloaded companion starts after the retired generation finishes installing', async () => {
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({ companion: { enabled: true } }),
    );
    const binary = getCompanionBinaryPath();
    const target = getCompanionTarget();
    const archive = `oh-my-opencode-slim-companion-v${COMPANION_MANIFEST.version}-${target}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
    const bytes = Buffer.from('verified companion archive');
    const checksums = COMPANION_MANIFEST.checksums;
    COMPANION_MANIFEST.checksums = {
      ...checksums,
      [archive]: createHash('sha256').update(bytes).digest('hex'),
    };
    const download = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const installed = Promise.withResolvers<void>();
    const loaded = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    const attempts: Promise<unknown>[] = [];
    const originalEnsure = companionUpdater.ensureCompanionVersionForStartup;
    const ensure = spyOn(
      companionUpdater,
      'ensureCompanionVersionForStartup',
    ).mockImplementation((...args) => {
      const pending = originalEnsure(...args);
      attempts.push(pending);
      if (attempts.length === 2) joined.resolve();
      return pending;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      started.resolve();
      return download.promise;
    }) as typeof fetch;
    const extractBinary = (destination: string) => {
      writeFileSync(path.join(destination, path.basename(binary)), 'binary');
    };
    const originalCrossSpawn = compat.crossSpawn;
    const extractTar = spyOn(compat, 'crossSpawn').mockImplementation(
      (command, options) => {
        if (command[0] !== 'tar') return originalCrossSpawn(command, options);
        extractBinary(command[4]);
        return { exited: Promise.resolve(0) } as ReturnType<
          typeof compat.crossSpawn
        >;
      },
    );
    const extractZip = spyOn(zip, 'extractZip').mockImplementation(
      async (_archive, destination) => extractBinary(destination),
    );
    const originalRename = fs.renameSync;
    const rename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      originalRename(from, to);
      if (String(to) === binary) installed.resolve();
    });
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      unref: () => {},
      kill: () => true,
    });
    const spawn = spyOn(childProcess, 'spawn').mockReturnValue(
      child as childProcess.ChildProcess,
    );
    const originalLoad = CompanionManager.prototype.onLoad;
    const load = spyOn(CompanionManager.prototype, 'onLoad').mockImplementation(
      function (this: CompanionManager) {
        originalLoad.call(this);
        loaded.resolve();
      },
    );
    jest.useFakeTimers();
    let first: Awaited<ReturnType<typeof plugin>> | undefined;
    let current: Awaited<ReturnType<typeof plugin>> | undefined;
    try {
      first = await createHooks();
      await started.promise;
      await first.dispose?.();
      current = await createHooks();
      await joined.promise;
      expect(attempts[1]).toBe(attempts[0]);
      download.resolve(new Response(bytes));
      await installed.promise;
      await loaded.promise;
      expect(load).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(binary, [], expect.any(Object));
    } finally {
      await first?.dispose?.();
      await current?.dispose?.();
      download.resolve(new Response(bytes));
      jest.useRealTimers();
      await Promise.allSettled(attempts);
      ensure.mockRestore();
      load.mockRestore();
      spawn.mockRestore();
      rename.mockRestore();
      extractZip.mockRestore();
      extractTar.mockRestore();
      globalThis.fetch = originalFetch;
      COMPANION_MANIFEST.checksums = checksums;
    }
  });

  test('disposing the last companion consumer stops waiting for another process', async () => {
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({ companion: { enabled: true } }),
    );
    const binary = getCompanionBinaryPath();
    const lock = `${binary}.lock`;
    fs.mkdirSync(lock, { recursive: true });
    writeFileSync(path.join(lock, 'owner'), 'another process');
    const waiting = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    const originalDelay = promiseTimers.setTimeout;
    const delay = spyOn(promiseTimers, 'setTimeout').mockImplementation(((
      ...args: Parameters<typeof originalDelay>
    ) => {
      waiting.resolve();
      return originalDelay(...args);
    }) as typeof originalDelay);
    const originalEnsure = companionUpdater.ensureCompanionVersionForStartup;
    const attempts: ReturnType<typeof originalEnsure>[] = [];
    const ensure = spyOn(
      companionUpdater,
      'ensureCompanionVersionForStartup',
    ).mockImplementation((...args) => {
      const pending = originalEnsure(...args);
      attempts.push(pending);
      if (attempts.length === 2) joined.resolve();
      return pending;
    });
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => new Response('', { status: 503 }));
    globalThis.fetch = fetchMock as typeof fetch;
    jest.useFakeTimers();
    let first: Awaited<ReturnType<typeof plugin>> | undefined;
    let current: Awaited<ReturnType<typeof plugin>> | undefined;
    try {
      first = await createHooks({ hostFlavor: 'v2' });
      await waiting.promise;
      current = await createHooks({ hostFlavor: 'v2' });
      await joined.promise;
      expect(attempts[1]).toBe(attempts[0]);
      const signal = delay.mock.calls[0]?.[2]?.signal;
      expect(signal?.aborted).toBe(false);
      await first.event?.({
        event: { type: 'server.instance.disposed' },
      } as never);
      expect(signal?.aborted).toBe(false);
      await current.dispose?.();
      expect(signal?.aborted).toBe(true);
      expect(readFileSync(path.join(lock, 'owner'), 'utf8')).toBe(
        'another process',
      );
      fs.rmSync(lock, { recursive: true });
      jest.advanceTimersByTime(25);
      await attempts[0];
      expect(fetchMock).not.toHaveBeenCalled();
      expect(fs.existsSync(binary)).toBe(false);
    } finally {
      await first?.dispose?.();
      await current?.dispose?.();
      fs.rmSync(lock, { recursive: true, force: true });
      jest.advanceTimersByTime(25);
      await Promise.allSettled(attempts);
      jest.useRealTimers();
      globalThis.fetch = originalFetch;
      ensure.mockRestore();
      delay.mockRestore();
    }
  });

  test('companion keeps other input requests pending when one is resolved', async () => {
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: { enabled: true, binaryPath: `${projectDir}/missing` },
      }),
    );
    const hooks = await createHooks();
    try {
      const send = (type: string, properties: Record<string, unknown>) =>
        hooks.event?.({ event: { type, properties } } as never);
      await send('session.status', {
        sessionID: 'child-a',
        status: { type: 'busy' },
      });
      await send('session.status', {
        sessionID: 'child-b',
        status: { type: 'busy' },
      });
      await send('permission.asked', { sessionID: 'child-a', id: 'a' });
      await send('permission.asked', { sessionID: 'child-b', id: 'b' });
      await send('permission.asked', { sessionID: 'child-b', id: 'b' });
      await send('permission.replied', {
        sessionID: 'child-a',
        requestID: 'a',
      });
      const row = () =>
        JSON.parse(readFileSync(stateFilePath(), 'utf8')).sessions[0];
      expect(row().status).toBe('waiting-input');
      expect(row().attention_seq).toBe(2);
      await send('permission.replied', {
        sessionID: 'child-b',
        requestID: 'b',
      });
      expect(row().status).toBe('busy');
    } finally {
      await hooks.dispose?.();
    }
  });

  test('companion clears cancelled waits only for the terminated or deleted session', async () => {
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: { enabled: true, binaryPath: `${projectDir}/missing` },
      }),
    );
    const hooks = await createHooks();
    try {
      const send = (type: string, properties: Record<string, unknown>) =>
        hooks.event?.({ event: { type, properties } } as never);
      await send('session.status', {
        sessionID: 'a',
        status: { type: 'busy' },
      });
      await send('session.status', {
        sessionID: 'b',
        status: { type: 'busy' },
      });
      await send('permission.asked', { sessionID: 'a', id: 'permission' });
      await send('question.asked', { sessionID: 'b', id: 'question' });
      await send('session.idle', { sessionID: 'a' });
      const row = () =>
        JSON.parse(readFileSync(stateFilePath(), 'utf8')).sessions[0];
      expect(row().status).toBe('waiting-input');
      await send('session.deleted', { info: { id: 'b' }, sessionID: 'b' });
      expect(row()).toMatchObject({ status: 'idle', active_agents: ['intro'] });
    } finally {
      await hooks.dispose?.();
    }
  });
});

describe('plugin TUI agent activity', () => {
  let originalEnv: typeof process.env;
  let projectDir: string;
  let hooks: Awaited<ReturnType<typeof plugin>> | undefined;
  const createActivityPlugin = () =>
    plugin({
      client: createPluginClient(async () => ({})),
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

  beforeEach(async () => {
    originalEnv = { ...process.env };
    projectDir = await mkdtemp('/tmp/oh-my-opencode-slim-tui-activity-');
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: projectDir,
      XDG_DATA_HOME: `${projectDir}/data`,
      XDG_CACHE_HOME: `${projectDir}/cache`,
      OPENCODE_LOG_DIR: `${projectDir}/logs`,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({ companion: { enabled: false } }),
    );

    hooks = await createActivityPlugin();
  });

  afterEach(async () => {
    await hooks?.dispose?.();
    process.env = originalEnv;
    await rm(projectDir, { recursive: true, force: true });
  });

  const busy = (sessionID: string) =>
    hooks?.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID, status: { type: 'busy' } },
      },
    } as never);

  test('keeps an agent active until all of its sessions stop', async () => {
    const chatMessage = hooks?.['chat.message'];
    expect(chatMessage).toBeFunction();

    await chatMessage?.(
      { sessionID: 'fixer-a', agent: 'fixer' } as never,
      {} as never,
    );
    await chatMessage?.(
      { sessionID: 'fixer-b', agent: 'fixer' } as never,
      {} as never,
    );
    await busy('fixer-a');
    await busy('fixer-b');

    await hooks?.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID: 'fixer-a', status: { type: 'idle' } },
      },
    } as never);

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({
      'fixer-b': 'fixer',
    });

    await hooks?.event?.({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 'fixer-b' } },
      },
    } as never);

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({});
  });

  test('clears active sessions when plugin disposes', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'oracle-a', agent: 'oracle' } as never,
      {} as never,
    );
    await busy('oracle-a');

    await hooks?.dispose?.();

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({});
  });

  test('second plugin init in the same PID does not wipe the first instance activity', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'oracle-live', agent: 'oracle' } as never,
      {} as never,
    );
    await busy('oracle-live');
    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({
      'oracle-live': 'oracle',
    });

    const second = await createActivityPlugin();
    try {
      expect(readTuiSnapshot(projectDir).activeSessions).toEqual({
        'oracle-live': 'oracle',
      });
    } finally {
      await second.dispose?.();
    }
  });

  test('server disposal preserves activity owned by another plugin instance', async () => {
    const otherHooks = await createActivityPlugin();

    try {
      await hooks?.['chat.message']?.(
        { sessionID: 'oracle-a', agent: 'oracle' } as never,
        {} as never,
      );
      await otherHooks['chat.message']?.(
        { sessionID: 'explorer-b', agent: 'explorer' } as never,
        {} as never,
      );
      await busy('oracle-a');
      await otherHooks.event?.({
        event: {
          type: 'session.status',
          properties: { sessionID: 'explorer-b', status: { type: 'busy' } },
        },
      } as never);

      await hooks?.event?.({
        event: { type: 'server.instance.disposed' },
      } as never);

      expect(readTuiSnapshot(projectDir).activeSessions).toEqual({
        'explorer-b': 'explorer',
      });
    } finally {
      await otherHooks.dispose?.();
    }
  });

  test('hydrates the full ancestry chain with the SDK receiver intact', async () => {
    const calls: string[] = [];
    const receivers: unknown[] = [];
    const sessionApi = {
      async get(this: unknown, input: { path: { id: string } }) {
        calls.push(input.path.id);
        receivers.push(this);
        const parents: Record<string, string | undefined> = {
          grandchild: 'child',
          child: 'root',
          root: undefined,
        };
        return { data: { parentID: parents[input.path.id] } };
      },
    };
    const chainHooks = await plugin({
      client: { session: sessionApi },
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    try {
      await chainHooks?.event?.({
        event: {
          type: 'session.status',
          properties: { sessionID: 'grandchild', status: { type: 'busy' } },
        },
      } as never);
      await chainHooks?.['chat.message']?.(
        { sessionID: 'grandchild', agent: 'fixer' } as never,
        {} as never,
      );
      // Fire-and-forget hydration; give the microtask queue a beat.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const snapshot = readTuiSnapshot(projectDir);
      expect(snapshot.sessionParents).toEqual({
        grandchild: 'child',
        child: 'root',
      });
      expect(calls).toEqual(['grandchild', 'child', 'root']);
      // The SDK method must run with its receiver (#595 class of bug).
      for (const receiver of receivers) {
        expect(receiver).toBe(sessionApi);
      }
    } finally {
      await chainHooks?.dispose?.();
    }
  });

  test('rehydrates a lost child-parent link without requerying the confirmed root', async () => {
    const childResponse = Promise.withResolvers<{
      data: { parentID: string };
    }>();
    const rootResponse = Promise.withResolvers<{
      data: { parentID?: string };
    }>();
    const get = mock((input: { path: { id: string } }) =>
      input.path.id === 'child' ? childResponse.promise : rootResponse.promise,
    );
    await hooks?.dispose?.();
    hooks = await plugin({
      client: { session: { get } },
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    await hooks?.['chat.message']?.(
      { sessionID: 'child', agent: 'fixer' } as never,
      {} as never,
    );
    await busy('child');
    // Hydration awaits these same promises before the test, so its
    // continuations finish before each corresponding test continuation.
    childResponse.resolve({ data: { parentID: 'root' } });
    await childResponse.promise;
    rootResponse.resolve({ data: {} });
    await rootResponse.promise;
    expect(readTuiSnapshot(projectDir).sessionParents.child).toBe('root');

    expect(
      updateSnapshot(projectDir, (snapshot) => {
        delete snapshot.sessionParents.child;
      }),
    ).toBe(true);
    expect(readTuiSnapshot(projectDir).sessionParents.child).toBeUndefined();

    await busy('child');
    await childResponse.promise;

    expect(
      get.mock.calls.filter(([input]) => input.path.id === 'child'),
    ).toHaveLength(2);
    expect(readTuiSnapshot(projectDir).sessionParents.child).toBe('root');
    expect(
      get.mock.calls.filter(([input]) => input.path.id === 'root'),
    ).toHaveLength(1);
  });

  test('does not cache an errored host lookup as a confirmed root', async () => {
    let attempts = 0;
    const sessionApi = {
      async get(input: { path: { id: string } }) {
        attempts += 1;
        if (attempts === 1) {
          // HTTP error resolved instead of thrown (SDK default).
          return { error: { status: 503 }, data: undefined };
        }
        if (input.path.id === 'real-root') {
          return { data: { parentID: undefined } }; // Confirmed root.
        }
        return { data: { parentID: 'real-root' } };
      },
    };
    const retryHooks = await plugin({
      client: { session: sessionApi },
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    try {
      await retryHooks?.event?.({
        event: {
          type: 'session.status',
          properties: { sessionID: 'orphan-a', status: { type: 'busy' } },
        },
      } as never);
      await retryHooks?.['chat.message']?.(
        { sessionID: 'orphan-a', agent: 'fixer' } as never,
        {} as never,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(readTuiSnapshot(projectDir).sessionParents).toEqual({});

      // A later activation must retry: the failed slot was released.
      await retryHooks?.event?.({
        event: {
          type: 'session.status',
          properties: { sessionID: 'orphan-a', status: { type: 'busy' } },
        },
      } as never);
      await retryHooks?.['chat.message']?.(
        { sessionID: 'orphan-a', agent: 'fixer' } as never,
        {} as never,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      // 1st: 503 (released). 2nd: retry yields the parent. 3rd: confirms
      // real-root has no further parent (walk to a confirmed root).
      expect(attempts).toBe(3);
      expect(readTuiSnapshot(projectDir).sessionParents['orphan-a']).toBe(
        'real-root',
      );
    } finally {
      await retryHooks?.dispose?.();
    }
  });

  test('does not cache a malformed parentID as a confirmed root', async () => {
    let attempts = 0;
    const sessionApi = {
      async get(_input: { path: { id: string } }) {
        attempts += 1;
        if (attempts === 1) {
          // Malformed non-string parent: contract violation, not a root.
          return { data: { parentID: 123 } };
        }
        return { data: { parentID: 'fixed-root' } };
      },
    };
    const malformedHooks = await plugin({
      client: { session: sessionApi },
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    try {
      await malformedHooks?.event?.({
        event: {
          type: 'session.status',
          properties: { sessionID: 'broken-a', status: { type: 'busy' } },
        },
      } as never);
      await malformedHooks?.['chat.message']?.(
        { sessionID: 'broken-a', agent: 'fixer' } as never,
        {} as never,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(readTuiSnapshot(projectDir).sessionParents).toEqual({});

      // A later activation must retry: the malformed slot was released.
      await malformedHooks?.event?.({
        event: {
          type: 'session.status',
          properties: { sessionID: 'broken-a', status: { type: 'busy' } },
        },
      } as never);
      await malformedHooks?.['chat.message']?.(
        { sessionID: 'broken-a', agent: 'fixer' } as never,
        {} as never,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(readTuiSnapshot(projectDir).sessionParents['broken-a']).toBe(
        'fixed-root',
      );
    } finally {
      await malformedHooks?.dispose?.();
    }
  });
  test('chat.message does not light a spinner without session.status busy', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'orch', agent: 'orchestrator' } as never,
      {} as never,
    );
    await hooks?.['chat.message']?.(
      { sessionID: 'research-child', agent: 'explorer' } as never,
      {} as never,
    );

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({});

    await busy('research-child');

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({
      'research-child': 'explorer',
    });
  });

  test('idle stays idle after a later chat.message on the same session', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'orch', agent: 'orchestrator' } as never,
      {} as never,
    );
    await busy('orch');
    await hooks?.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID: 'orch', status: { type: 'idle' } },
      },
    } as never);

    await hooks?.['chat.message']?.(
      { sessionID: 'orch', agent: 'orchestrator' } as never,
      {} as never,
    );

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({});
  });

  test('busy before the agent is known still lights the spinner on chat.message', async () => {
    await busy('late-agent');
    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({});

    await hooks?.['chat.message']?.(
      { sessionID: 'late-agent', agent: 'fixer' } as never,
      {} as never,
    );

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({
      'late-agent': 'fixer',
    });
  });

  test('agent change while busy moves the spinner to the new agent row', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'root', agent: 'orchestrator' } as never,
      {} as never,
    );
    await busy('root');
    await hooks?.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID: 'root', status: { type: 'idle' } },
      },
    } as never);
    await busy('root');

    await hooks?.['chat.message']?.(
      { sessionID: 'root', agent: 'fixer' } as never,
      {} as never,
    );

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({
      root: 'fixer',
    });
  });

  test('message.part.delta does not write TUI activity or agent model', async () => {
    await hooks?.['chat.message']?.(
      {
        sessionID: 'stream-1',
        agent: 'orchestrator',
        model: { providerID: 'openai', modelID: 'gpt-4o' },
      } as never,
      {} as never,
    );
    const before = readTuiSnapshot(projectDir);

    await hooks?.event?.({
      event: {
        type: 'message.part.delta',
        properties: {
          sessionID: 'stream-1',
          messageID: 'msg-1',
          partID: 'part-1',
          field: 'text',
          delta: 'a'.repeat(200),
        },
      },
    } as never);

    const after = readTuiSnapshot(projectDir);
    expect(after.activeSessions).toEqual(before.activeSessions);
    expect(after.agentModels).toEqual(before.agentModels);
    expect(snapshotSectionsEqual(after, before)).toBe(true);
  });

  test('observed models never enter raw per-session TUI details', async () => {
    const chat = (modelID: string) =>
      hooks?.['chat.message']?.(
        {
          sessionID: 'ora-m',
          agent: 'oracle',
          model: { providerID: 'openai', modelID },
        } as never,
        {} as never,
      );
    await chat('gpt-6');
    await busy('ora-m');
    await chat('gpt-6-luna');
    await hooks?.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'ora-m',
            providerID: 'openai',
            modelID: 'gpt-6-sol',
          },
        },
      },
    } as never);

    const raw = JSON.parse(readFileSync(getTuiStatePath(projectDir), 'utf8'));
    expect(raw.sessionDetails['ora-m']).toEqual({ status: 'busy' });
  });

  test('chat.message model after idle does not resurrect sessionDetails', async () => {
    await hooks?.['chat.message']?.(
      {
        sessionID: 'ora-idle',
        agent: 'oracle',
        model: { providerID: 'openai', modelID: 'gpt-6' },
      } as never,
      {} as never,
    );
    await busy('ora-idle');
    await hooks?.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ora-idle', status: { type: 'idle' } },
      },
    } as never);

    await hooks?.['chat.message']?.(
      {
        sessionID: 'ora-idle',
        agent: 'oracle',
        model: { providerID: 'openai', modelID: 'gpt-6' },
      } as never,
      {} as never,
    );

    expect(readTuiSnapshot(projectDir).activeSessions).toEqual({});
    expect(readTuiSnapshot(projectDir).sessionDetails).toEqual({});
  });

  const _launchChild = async (
    parentID: string,
    childID: string,
    callID: string,
  ) => {
    await hooks?.['tool.execute.before']?.(
      { tool: 'task', sessionID: parentID, callID } as never,
      {
        args: {
          background: true,
          subagent_type: 'oracle',
          description: 'sidebar child',
        },
      } as never,
    );
    await hooks?.['tool.execute.after']?.(
      { tool: 'task', sessionID: parentID, callID } as never,
      {
        output: [
          `task_id: ${childID}`,
          'state: running',
          '',
          '<task_result>',
          'Background task started.',
          '</task_result>',
        ].join('\n'),
      } as never,
    );
  };

  test('unattributed terminal output defers until idle evidence clears it', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'parent-4', agent: 'orchestrator' } as never,
      {} as never,
    );
    // The pending call is registered under a different callID than the
    // returning output, so attribution is text-parsed, never
    // callID-confirmed: the #1215 fast path must not fire. The child's
    // session.created early-registers the pending for this task ID, so
    // the mismatched return still resolves identity — unconfirmed.
    await hooks?.['tool.execute.before']?.(
      { tool: 'task', sessionID: 'parent-4', callID: 'call-fg-2a' } as never,
      {
        args: {
          background: false,
          subagent_type: 'oracle',
          description: 'foreground child',
        },
      } as never,
    );
    await hooks?.event?.({
      event: {
        type: 'session.created',
        properties: {
          info: { id: 'child-fg-2', parentID: 'parent-4', agent: 'oracle' },
        },
      },
    } as never);
    await hooks?.['chat.message']?.(
      { sessionID: 'child-fg-2', agent: 'oracle' } as never,
      {} as never,
    );
    await busy('child-fg-2');

    expect(readTuiSnapshot(projectDir).activeSessions['child-fg-2']).toBe(
      'oracle',
    );

    await hooks?.['tool.execute.after']?.(
      { tool: 'task', sessionID: 'parent-4', callID: 'call-fg-2b' } as never,
      {
        output: [
          'task_id: child-fg-2',
          'state: completed',
          '',
          '<task_result>',
          'Analysis finished.',
          '</task_result>',
        ].join('\n'),
      } as never,
    );

    // Unconfirmed attribution keeps the full runtime discipline: the
    // terminal text alone must not clear the active session yet.
    expect(readTuiSnapshot(projectDir).activeSessions['child-fg-2']).toBe(
      'oracle',
    );

    // Idle runtime evidence is what publishes the terminal state.
    await hooks?.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID: 'child-fg-2', status: { type: 'idle' } },
      },
    } as never);
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const snapshot = readTuiSnapshot(projectDir);
    expect(snapshot.activeSessions['child-fg-2']).toBeUndefined();
    expect(snapshot.sessionDetails['child-fg-2']).toBeUndefined();
  });

  test('string status idle clears active sessions', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'fixer-str', agent: 'fixer' } as never,
      {} as never,
    );
    await busy('fixer-str');
    expect(readTuiSnapshot(projectDir).activeSessions['fixer-str']).toBe(
      'fixer',
    );

    await hooks?.event?.({
      event: {
        type: 'session.status',
        properties: { sessionID: 'fixer-str', status: 'idle' },
      },
    } as never);

    expect(
      readTuiSnapshot(projectDir).activeSessions['fixer-str'],
    ).toBeUndefined();
  });

  test('session.error clears active sessions', async () => {
    await hooks?.['chat.message']?.(
      { sessionID: 'oracle-err', agent: 'oracle' } as never,
      {} as never,
    );
    await busy('oracle-err');
    expect(readTuiSnapshot(projectDir).activeSessions['oracle-err']).toBe(
      'oracle',
    );

    await hooks?.event?.({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'oracle-err',
          error: { message: 'Task failed' },
        },
      },
    } as never);

    expect(
      readTuiSnapshot(projectDir).activeSessions['oracle-err'],
    ).toBeUndefined();
  });
});

describe('plugin config model inheritance', () => {
  let originalEnv: typeof process.env;
  const configDirs: string[] = [];
  // Directory of the most recent loadConfiguredPlugin() call, for tests
  // that need the RuntimeConfig singleton the plugin initialized.
  let lastConfigDir: string | undefined;
  let client: ReturnType<typeof createPluginClient>;
  const hostChildren = new Map<
    string,
    { parentID: string; prompted: boolean }
  >();
  const transcripts = new Map<string, unknown[]>();
  const primary = { providerID: 'openrouter', modelID: 'openrouter/auto' };
  const fallback = { providerID: 'openai', modelID: 'gpt-6-luna' };
  const delegatedChain = ['openrouter/openrouter/auto', 'openai/gpt-6-luna'];
  const _delegatedFallbackConfig = {
    agents: {
      orchestrator: { model: delegatedChain },
      operator: { model: delegatedChain },
    },
  };

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    hostChildren.clear();
    transcripts.clear();
  });

  afterEach(async () => {
    process.env = originalEnv;
    while (configDirs.length > 0) {
      const configDir = configDirs.pop();
      if (configDir) {
        await rm(configDir, { recursive: true, force: true });
      }
    }
  });

  async function loadConfiguredPlugin(
    config: Record<string, unknown>,
    existingDirectory?: string,
    hostFlavor?: 'v2',
  ) {
    const configDir =
      existingDirectory ??
      (await mkdtemp(path.join(os.tmpdir(), 'oh-my-opencode-inheritance-')));
    if (!existingDirectory) configDirs.push(configDir);
    lastConfigDir = configDir;
    await Bun.write(
      `${configDir}/oh-my-opencode-slim.json`,
      JSON.stringify(config),
    );
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_DATA_HOME: `${configDir}/data`,
      XDG_CACHE_HOME: `${configDir}/cache`,
      OPENCODE_LOG_DIR: `${configDir}/logs`,
    };

    client = createPluginClient(async () => ({}));
    client.session.status = async () => ({ data: {} });
    client.session.get = async ({ path }: { path: { id: string } }) => {
      const child = hostChildren.get(path.id);
      return child ? { data: { parentID: child.parentID } } : {};
    };
    client.session.messages = async ({ path }: { path: { id: string } }) => ({
      data:
        hostChildren.get(path.id)?.prompted === false
          ? []
          : (transcripts.get(path.id) ?? [
              {
                info: {
                  role: 'assistant',
                  time: { completed: Date.now() },
                  finish: 'stop',
                },
                parts: [{ type: 'text', text: 'done' }],
              },
            ]),
    });
    return plugin({
      client,
      directory: configDir,
      worktree: configDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
      hostFlavor,
    } as never);
  }

  test('loads legacy custom primaries as specialists across agent and preset configs', async () => {
    const hooks = await loadConfiguredPlugin({
      preset: 'team',
      agents: {
        coworker: {
          primary: true,
          model: 'test/coworker',
          subagents: ['fixer'],
        },
        orchestrator: { subagents: ['coworker', 'reviewer', 'writer'] },
      },
      presets: {
        base: { reviewer: { primary: true, model: 'test/reviewer' } },
        team: {
          extends: 'base',
          agents: {
            writer: { primary: true, model: 'test/writer' },
            primary: { primary: true, model: 'test/specialist' },
          },
        },
      },
    });
    try {
      const hostConfig: { agent?: Record<string, unknown> } = {};
      await hooks.config?.(hostConfig);
      expect(hostConfig.agent).toMatchObject({
        orchestrator: {
          mode: 'primary',
          permission: {
            task: {
              '*': 'deny',
              coworker: 'allow',
              reviewer: 'allow',
              writer: 'allow',
            },
          },
        },
        coworker: {
          mode: 'subagent',
          model: 'test/coworker',
          permission: { task_cancel: 'deny' },
        },
        reviewer: { mode: 'subagent', model: 'test/reviewer' },
        writer: { mode: 'subagent', model: 'test/writer' },
        primary: { mode: 'subagent', model: 'test/specialist' },
      });
    } finally {
      await hooks.dispose?.();
    }
  });

  async function selectParent(
    hooks: Awaited<ReturnType<typeof loadConfiguredPlugin>>,
    model: { providerID: string; modelID: string },
    sessionID = 'parent',
  ) {
    await hooks.config?.({ agent: {} });
    await hooks['chat.message']?.(
      { sessionID, agent: 'orchestrator', model } as never,
      {} as never,
    );
  }

  async function fallbackParent(
    hooks: Awaited<ReturnType<typeof loadConfiguredPlugin>>,
    sessionID: string,
    failure: 'provider' | 'content-filter' = 'provider',
  ) {
    transcripts.set(sessionID, [
      {
        info: { id: `msg-original-${sessionID}`, role: 'user', sessionID },
        parts: [{ type: 'text', text: 'delegate this work' }],
      },
    ]);
    await selectParent(hooks, primary, sessionID);
    const promptAsync = client.session.promptAsync as (
      input: unknown,
    ) => Promise<unknown>;
    const replay = mock(promptAsync);
    client.session.promptAsync = replay;
    try {
      await hooks.event?.({
        event: {
          type: 'message.updated',
          properties: {
            info: {
              id: `msg-primary-error-${sessionID}`,
              sessionID,
              role: 'assistant',
              agent: 'orchestrator',
              ...primary,
              ...(failure === 'content-filter'
                ? { finish: 'content-filter', time: { completed: Date.now() } }
                : {}),
            },
          },
        },
      } as never);
      if (failure === 'provider') {
        await hooks.event?.({
          event: {
            type: 'session.error',
            properties: {
              sessionID,
              error: { statusCode: 403, message: 'Key limit exceeded' },
            },
          },
        } as never);
      }
      expect(replay.mock.calls.at(-1)?.[0]).toMatchObject({
        path: { id: sessionID },
        body: { model: fallback },
      });
    } finally {
      client.session.promptAsync = promptAsync;
    }
  }

  async function _assertAdmissionUsesFinalModel(
    subagentType: string,
    config: Record<string, unknown>,
    hostAgent: Record<string, unknown>,
  ): Promise<void> {
    const hooks = await loadConfiguredPlugin(config);
    try {
      await hooks.config?.({ agent: hostAgent });
      await hooks['chat.message']?.(
        {
          sessionID: 'orchestrator-1',
          agent: 'orchestrator',
          model: { providerID: 'openai', modelID: 'parent' },
        } as never,
        {} as never,
      );
      const first = hooks['tool.execute.before']?.(
        {
          tool: 'task',
          sessionID: 'orchestrator-1',
          callID: 'call-1',
        } as never,
        {
          args: {
            background: true,
            subagent_type: subagentType,
            description: 'first admission',
          },
        } as never,
      );
      const second = hooks['tool.execute.before']?.(
        {
          tool: 'task',
          sessionID: 'orchestrator-1',
          callID: 'call-2',
        } as never,
        {
          args: {
            background: true,
            subagent_type: subagentType,
            description: 'second admission',
          },
        } as never,
      );

      await first;
      const queued = await Promise.race([
        second?.then(
          () => 'admitted',
          () => 'rejected',
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('still-queued'), 30),
        ),
      ]);
      expect(queued).toBe('still-queued');

      await hooks['tool.execute.after']?.(
        {
          tool: 'task',
          sessionID: 'orchestrator-1',
          callID: 'call-1',
        } as never,
        {
          output: 'task_id: child-1\nstate: completed\nresult: done',
        } as never,
      );
      await second;
    } finally {
      await hooks.dispose?.();
    }
  }

  /** Prompt before session.created reaches the plugin; persist after the hook. */
  async function delegateV1Child(
    hooks: Awaited<ReturnType<typeof loadConfiguredPlugin>>,
    parentSessionID: string,
    callID: string,
    primary: { providerID: string; modelID: string },
    options: { background?: boolean; task_id?: string; agent?: string } = {},
  ) {
    const { agent = 'operator', ...taskOptions } = options;
    const output = {
      args: {
        subagent_type: agent,
        description: 'verify fallback routing',
        prompt: 'return ok',
        ...taskOptions,
      },
    };
    const task = { tool: 'task', sessionID: parentSessionID, callID };
    await hooks['tool.execute.before']?.(task as never, output as never);
    if (options.background) {
      // A background task returns before its child's first prompt.
      await hooks['tool.execute.after']?.(
        { ...task, args: output.args } as never,
        { title: '', output: 'started', metadata: {} } as never,
      );
    }
    const childID = options.task_id ?? `ses_child_${callID}`;
    if (!hostChildren.has(childID)) {
      hostChildren.set(childID, { parentID: parentSessionID, prompted: false });
    }
    const childOutput = {
      message: {
        id: `msg-${childID}`,
        role: 'user',
        sessionID: childID,
        agent,
        model: { ...primary },
      },
      parts: [{ type: 'text', text: 'return ok' }],
    };
    await hooks['chat.message']?.(
      { sessionID: childID, agent, model: primary } as never,
      childOutput as never,
    );
    hostChildren.set(childID, { parentID: parentSessionID, prompted: true });
    return {
      subagentType: output.args.subagent_type,
      childModel: childOutput.message.model,
      childOutput,
    };
  }

  test('v2 provider fallback routes to the first healthy child entry with its variant', async () => {
    const hooks = await loadConfiguredPlugin(
      {
        fallback: { maxRetries: 0 },
        agents: {
          orchestrator: { model: ['provider/primary', 'backup/parent'] },
          operator: {
            model: ['provider/child', { id: 'backup/child', variant: 'max' }],
          },
        },
      },
      undefined,
      'v2',
    );
    try {
      await selectParent(hooks, { providerID: 'provider', modelID: 'primary' });
      expect(
        (hooks as any)['v2.resolveDelegatedModel']({
          agentType: 'operator',
          parentSessionID: 'parent',
        }),
      ).toBeUndefined();
      const switchModel = mock(async () => ({}));
      await hooks['v2.session.retry']?.(
        {
          sessionID: 'parent',
          agent: 'orchestrator',
          model: { providerID: 'provider', id: 'primary' },
          error: { type: 'provider.rate-limit', message: 'rate limit' },
          decision: { retry: true },
        } as never,
        switchModel as never,
      );
      expect(switchModel).toHaveBeenCalledWith('parent', {
        providerID: 'backup',
        id: 'parent',
      });
      expect(
        (hooks as any)['v2.resolveDelegatedModel']({
          agentType: 'operator',
          parentSessionID: 'parent',
        }),
      ).toBe('backup/child#max');
    } finally {
      await hooks.dispose?.();
    }
  });

  test('session inheritance removes a stale host model in the final config', async () => {
    const hooks = await loadConfiguredPlugin({
      agents: {
        explorer: { model: 'local/explorer' },
        fixer: { inheritModelFrom: 'session' },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        orchestrator: { model: 'host/orchestrator' },
        fixer: { model: 'host/stale-fixer', temperature: 0.2 },
      },
    };

    try {
      await hooks.config?.(hostConfig);

      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      expect(agents.fixer?.model).toBeUndefined();
      expect(agents.fixer?.temperature).toBe(0.2);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('session inheritance removes stale visible alias models and variants', async () => {
    const hooks = await loadConfiguredPlugin({
      agents: {
        explorer: { displayName: 'Scout', inheritModelFrom: 'session' },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        explorer: { model: 'host/canonical', variant: 'canonical-v' },
        Scout: { model: 'host/visible', variant: 'visible-v' },
      },
    };

    try {
      await hooks.config?.(hostConfig);

      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      for (const name of ['explorer', 'Scout']) {
        expect(agents[name]).not.toHaveProperty('model');
        expect(agents[name]).not.toHaveProperty('variant');
      }
    } finally {
      await hooks.dispose?.();
    }
  });

  test('orchestrator inheritance leaves the child model-less for live parent selection', async () => {
    const hooks = await loadConfiguredPlugin({
      agents: {
        oracle: { inheritModelFrom: 'orchestrator' },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        orchestrator: { model: 'host/orchestrator' },
        oracle: { model: 'host/stale-oracle' },
      },
    };

    try {
      await hooks.config?.(hostConfig);

      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      expect(agents.oracle?.model).toBeUndefined();
    } finally {
      await hooks.dispose?.();
    }
  });

  async function _assertInheritedRevive(
    operator: Record<string, unknown>,
    parentFallsBack = true,
  ) {
    const hooks = await loadConfiguredPlugin({
      agents: { orchestrator: { model: delegatedChain }, operator },
    });
    try {
      await selectParent(hooks, primary);
      const { childOutput } = await delegateV1Child(
        hooks,
        'parent',
        'inherited',
        primary,
      );
      const sessionID = childOutput.message.sessionID;
      await hooks['tool.execute.after']?.(
        { tool: 'task', sessionID: 'parent', callID: 'inherited' } as never,
        {
          output: `task_id: ${sessionID}\nstate: completed\nresult: done`,
        } as never,
      );
      if (parentFallsBack) await fallbackParent(hooks, 'parent');
      else await selectParent(hooks, fallback);
      client.session.promptAsync = async () => {
        await hooks['chat.message']?.(
          { sessionID, agent: 'operator' } as never,
          childOutput as never,
        );
        return {};
      };
      await hooks.tool?.task_revive.execute(
        { task_id: sessionID, prompt: 'continue' },
        { sessionID: 'parent', agent: 'orchestrator' } as never,
      );
      expect(childOutput.message.model).toEqual(fallback);
    } finally {
      await hooks.dispose?.();
    }
  }

  test('preset inheritance clears a stale host model in the final config', async () => {
    const hooks = await loadConfiguredPlugin({
      preset: 'split',
      presets: {
        split: {
          orchestrator: { model: 'preset/orchestrator' },
          fixer: { inheritModelFrom: 'session' },
        },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        orchestrator: { model: 'host/orchestrator' },
        fixer: { model: 'host/stale-fixer', temperature: 0.4 },
      },
    };

    try {
      await hooks.config?.(hostConfig);

      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      expect(agents.fixer?.model).toBeUndefined();
      expect(agents.fixer?.temperature).toBe(0.4);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('combined inherit + chain keeps the final config on the session model', async () => {
    // Array model + inheritModelFrom: the chain head must not be pinned as
    // the launch model by the array-resolution pass — the agent follows the
    // session model and keeps the array purely as the fallback chain.
    const hooks = await loadConfiguredPlugin({
      agents: {
        fixer: {
          model: ['chain/primary', 'chain/backup'],
          inheritModelFrom: 'session',
        },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        orchestrator: { model: 'host/orchestrator' },
        fixer: { model: 'host/stale-fixer', temperature: 0.3 },
      },
    };

    try {
      await hooks.config?.(hostConfig);

      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      expect(agents.fixer?.model).toBeUndefined();
      expect(agents.fixer?.temperature).toBe(0.3);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('combined inherit + chain clears the chain head inline variant from the final config', async () => {
    // Greptile review repro: the array pass stamps the chain head model AND
    // its inline variant into the host entry; inheritance clears the model
    // and must take the stale variant with it — the followed session model
    // must not run with a fallback model's variant.
    const hooks = await loadConfiguredPlugin({
      agents: {
        fixer: {
          model: [{ id: 'chain/primary', variant: 'high' }, 'chain/backup'],
          inheritModelFrom: 'session',
        },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        orchestrator: { model: 'host/orchestrator' },
      },
    };

    try {
      await hooks.config?.(hostConfig);

      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      expect(agents.fixer?.model).toBeUndefined();
      expect(agents.fixer?.variant).toBeUndefined();
    } finally {
      await hooks.dispose?.();
    }
  });

  test('/model pick on a combined agent does not mark it model-switched', async () => {
    // A host-persisted /model pick is the combined agent's follow target;
    // it must not trip everModelSwitched (which disables the fallback
    // chain for static-chain agents).
    const hooks = await loadConfiguredPlugin({
      agents: {
        fixer: {
          model: ['chain/primary', 'chain/backup'],
          inheritModelFrom: 'session',
        },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        orchestrator: { model: 'host/orchestrator' },
        fixer: { model: 'user/live-pick' },
      },
    };

    try {
      await hooks.config?.(hostConfig);
      const runtime = RuntimeConfig.get(lastConfigDir as string);

      expect(runtime.hasModelSwitched('fixer')).toBe(false);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('/model pick away from the chain primary still marks static-chain agents', async () => {
    // Control for the exemption above: without inheritModelFrom, a /model
    // pick differing from the chain primary keeps disabling the chain.
    const hooks = await loadConfiguredPlugin({
      agents: {
        fixer: {
          model: ['chain/primary', 'chain/backup'],
        },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        orchestrator: { model: 'host/orchestrator' },
        fixer: { model: 'user/other-pick' },
      },
    };

    try {
      await hooks.config?.(hostConfig);
      const runtime = RuntimeConfig.get(lastConfigDir as string);

      expect(runtime.hasModelSwitched('fixer')).toBe(true);
    } finally {
      await hooks.dispose?.();
    }
  });

  test.each([
    [undefined, true],
    [['explorer', 'councillor-alpha'], false],
  ])(
    'council-inject follows the orchestrator seat pointer (scope %p)',
    async (subagents, expected) => {
      const hooks = await loadConfiguredPlugin({
        council: {
          presets: { default: { alpha: { model: 'test/councillor' } } },
        },
        agents: subagents ? { orchestrator: { subagents } } : {},
      });
      const transcript = {
        messages: [
          {
            info: {
              sessionID: 'council-scope',
              role: 'user',
              agent: 'orchestrator',
            },
            parts: [{ type: 'text', text: 'get a consensus on this' }],
          },
        ],
      };
      try {
        await hooks['experimental.chat.messages.transform']?.(
          {},
          transcript as never,
        );
        const injected = transcript.messages[0].parts.some((part) =>
          isTaggedPart(part as never, COUNCIL_INJECT_METADATA_KEY),
        );
        expect(injected).toBe(expected);
      } finally {
        await hooks.dispose?.();
      }
    },
  );

  test('config() keeps compaction exception after host council prompt override', async () => {
    const hooks = await loadConfiguredPlugin({
      council: {
        presets: { default: { alpha: { model: 'test/councillor' } } },
      },
      agents: {
        council: { displayName: 'ArchitectureCouncil' },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        council: { prompt: 'Always include ## Council Response.' },
        ArchitectureCouncil: {
          prompt: 'Always include ## Council Summary.',
        },
      },
    };

    try {
      await hooks.config?.(hostConfig);
      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      for (const key of ['council', 'ArchitectureCouncil'] as const) {
        expect(agents[key]?.prompt).toContain(
          'if the host asks you to produce a session checkpoint or compaction summary in a specific template',
        );
      }
      expect(agents.council?.prompt).toContain(
        'Always include ## Council Response.',
      );
      expect(agents.ArchitectureCouncil?.prompt).toContain(
        'Always include ## Council Summary.',
      );
    } finally {
      await hooks.dispose?.();
    }
  });

  test('config() writes the visible orchestrator display name as default_agent', async () => {
    const hooks = await loadConfiguredPlugin({
      council: {
        presets: { default: { alpha: { model: 'test/councillor' } } },
      },
      agents: {
        orchestrator: { displayName: 'EngineeringLead' },
        council: { displayName: 'ArchitectureCouncil' },
      },
    });
    const hostConfig: Record<string, unknown> = {};

    try {
      await hooks.config?.(hostConfig);

      // The orchestrator's visible entry is keyed by its display name;
      // canonical 'orchestrator' is only a hidden alias, so default_agent
      // must target the display-name entry.
      expect(hostConfig.default_agent).toBe('EngineeringLead');
      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      expect(agents.EngineeringLead?.hidden).toBeUndefined();
      expect(agents.orchestrator?.hidden).toBe(true);
      expect(agents.ArchitectureCouncil?.hidden).toBeUndefined();
      expect(agents.council?.hidden).toBe(true);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('visible host MCP permission denial overrides canonical allow', async () => {
    const hooks = await loadConfiguredPlugin({
      agents: {
        orchestrator: { displayName: 'EngineeringLead', mcps: ['context7'] },
      },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        orchestrator: { permission: { 'context7_*': 'allow' } },
        EngineeringLead: { permission: { 'context7_*': 'deny' } },
      },
    };

    try {
      await hooks.config?.(hostConfig);
      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      expect(
        ((agents.orchestrator?.permission ?? {}) as Record<string, unknown>)[
          'context7_*'
        ],
      ).toBe('allow');
      expect(
        ((agents.EngineeringLead?.permission ?? {}) as Record<string, unknown>)[
          'context7_*'
        ],
      ).toBe('deny');
    } finally {
      await hooks.dispose?.();
    }
  });

  test('repeated config hooks reproject the first owned registry snapshot', async () => {
    const hooks = await loadConfiguredPlugin({
      agents: { explorer: { model: ['plugin/first', 'plugin/next'] } },
    });
    const hostConfig: Record<string, unknown> = {
      agent: {
        explorer: {
          model: 'host/selected',
          prompt: 'host prompt',
          options: { nested: { stable: true } },
          permission: { read: 'allow', first_tool: 'allow' },
        },
      },
      mcp: { host_remote: { type: 'remote' } },
    };

    try {
      await hooks.config?.(hostConfig);
      const firstProjection = structuredClone(hostConfig);
      const changedAgents = hostConfig.agent as Record<string, unknown>;
      changedAgents.foreign_agent = { model: 'foreign/current' };
      const changedExplorer = changedAgents.explorer as Record<string, unknown>;
      changedExplorer.model = 'host/replay';
      changedExplorer.permission = {
        read: 'deny',
        replay_tool: 'allow',
      };
      const changedMcps = hostConfig.mcp as Record<string, unknown>;
      changedMcps.foreign_current = { type: 'remote' };
      await hooks.config?.(hostConfig);
      const agents = hostConfig.agent as Record<
        string,
        Record<string, unknown>
      >;
      expect(agents.foreign_agent).toEqual({ model: 'foreign/current' });
      expect(agents.explorer).toMatchObject({
        model: 'host/selected',
        prompt: 'host prompt',
        options: { nested: { stable: true } },
        permission: {
          read: 'allow',
          first_tool: 'allow',
          'host_remote_*': 'deny',
        },
      });
      expect(agents.explorer?.permission).not.toHaveProperty('replay_tool');
      expect(agents.explorer).toEqual(
        (firstProjection.agent as Record<string, unknown>).explorer,
      );
      expect(hostConfig.mcp).toMatchObject({
        host_remote: { type: 'remote' },
        foreign_current: { type: 'remote' },
      });
    } finally {
      await hooks.dispose?.();
    }
  });

  test('sticky model-switch fallback survives a fresh plugin generation', async () => {
    const config = {
      agents: { explorer: { model: ['provider/first', 'provider/next'] } },
    };
    const disableChain = spyOn(
      ForegroundFallbackManager.prototype,
      'disableChain',
    );
    let hooks = await loadConfiguredPlugin(config);
    const directory = lastConfigDir as string;
    try {
      await hooks.config?.({
        agent: { explorer: { model: 'provider/selected' } },
      });
      expect(RuntimeConfig.get(directory).hasModelSwitched('explorer')).toBe(
        true,
      );
      await hooks.dispose?.();

      hooks = await loadConfiguredPlugin(config, directory);
      await hooks.config?.({
        agent: { explorer: { model: 'provider/first' } },
      });
      expect(
        disableChain.mock.calls.filter(([agent]) => agent === 'explorer'),
      ).toHaveLength(2);
    } finally {
      await hooks.dispose?.();
      disableChain.mockRestore();
    }
  });

  test('releases runtime snapshots after the last generation and keeps reload state', async () => {
    const config = {
      presets: { runtime: { explorer: { temperature: 0.4 } } },
      agents: { explorer: { model: ['provider/first', 'provider/next'] } },
    };
    for (const hostFlavor of [undefined, 'v2'] as const) {
      const first = await loadConfiguredPlugin(config, undefined, hostFlavor);
      const directory = lastConfigDir as string;
      let second: Awaited<ReturnType<typeof loadConfiguredPlugin>> | undefined;
      let reloaded:
        | Awaited<ReturnType<typeof loadConfiguredPlugin>>
        | undefined;
      try {
        await first.config?.({
          agent: { explorer: { model: 'provider/selected' } },
        });
        const runtime = RuntimeConfig.get(directory);
        runtime.setRuntimePreset('runtime');
        expect(runtime.hasModelSwitched('explorer')).toBe(true);
        second = await loadConfiguredPlugin(config, directory, hostFlavor);
        await first.dispose?.();
        await first.dispose?.();
        expect(RuntimeConfig.get(directory)).toBe(runtime);
        expect(runtime.plugin).toBeDefined();
        await second.dispose?.();
        const afterDispose = RuntimeConfig.get(directory);
        expect(afterDispose).not.toBe(runtime);
        expect(afterDispose.plugin).toBeUndefined();
        expect(afterDispose.host()).toBeUndefined();
        reloaded = await loadConfiguredPlugin(config, directory, hostFlavor);
        expect(RuntimeConfig.get(directory).getRuntimePreset()).toBe('runtime');
        expect(RuntimeConfig.get(directory).hasModelSwitched('explorer')).toBe(
          true,
        );
      } finally {
        await first.dispose?.();
        await second?.dispose?.();
        await reloaded?.dispose?.();
        RuntimeConfig.reset(directory);
      }
    }
  });

  test('combined inheritance never disables its fallback chain for a model pick', async () => {
    const hooks = await loadConfiguredPlugin({
      agents: {
        explorer: {
          model: ['provider/first', 'provider/next'],
          inheritModelFrom: 'session',
        },
      },
    });
    const disableChain = spyOn(
      ForegroundFallbackManager.prototype,
      'disableChain',
    );
    try {
      await hooks.config?.({
        agent: { explorer: { model: 'provider/selected' } },
      });
      expect(disableChain).not.toHaveBeenCalledWith('explorer');
      expect(
        RuntimeConfig.get(lastConfigDir as string).hasModelSwitched('explorer'),
      ).toBe(false);
    } finally {
      await hooks.dispose?.();
      disableChain.mockRestore();
    }
  });
});

describe('system.transform orchestrator injection', () => {
  let originalEnv: typeof process.env;
  const configDirs: string[] = [];

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(async () => {
    process.env = originalEnv;
    while (configDirs.length > 0) {
      const configDir = configDirs.pop();
      if (configDir) {
        await rm(configDir, { recursive: true, force: true });
      }
    }
  });

  async function loadPluginWithOrchestratorSession(
    config: Record<string, unknown> = {},
  ) {
    const configDir = await mkdtemp(
      path.join(os.tmpdir(), 'oh-my-system-transform-'),
    );
    configDirs.push(configDir);
    await Bun.write(
      `${configDir}/oh-my-opencode-slim.json`,
      JSON.stringify(config),
    );
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_CONFIG_HOME: configDir,
      XDG_DATA_HOME: `${configDir}/data`,
      XDG_CACHE_HOME: `${configDir}/cache`,
      OPENCODE_LOG_DIR: `${configDir}/logs`,
    };
    const client = createPluginClient(async () => ({}));
    const hooks = await plugin({
      client,
      directory: configDir,
      worktree: configDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);
    // Session tracked as orchestrator (how chat.message records it).
    await hooks['chat.message']?.(
      {
        sessionID: 'ses-orc',
        agent: 'orchestrator',
        model: { providerID: 'test', modelID: 'm' },
      } as never,
      {} as never,
    );
    return hooks;
  }

  const ENV_BLOCK = [
    'You are powered by the model named test/m.',
    '<env>',
    '  Working directory: /tmp',
    '</env>',
  ].join('\n');

  test('does not duplicate a custom orchestrator prompt already present', async () => {
    // Configure a REAL custom replacement without default-prompt markers:
    // the effective prompt is this string, and the dedup must key on it.
    const customPrompt = 'Mi prompt custom sin marcadores.';
    const hooks = await loadPluginWithOrchestratorSession({
      agents: { orchestrator: { prompt: customPrompt } },
    });
    try {
      const system = [`${ENV_BLOCK}\n\n${customPrompt}`];
      await hooks['experimental.chat.system.transform']?.(
        { sessionID: 'ses-orc' } as never,
        { system } as never,
      );
      // Exactly one copy of the effective prompt (split = parts + 1) and
      // no default-prompt content appended after it.
      expect(system[0]?.split(customPrompt).length).toBe(2);
      expect(system[0]).toBe(`${ENV_BLOCK}\n\n${customPrompt}`);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('skips auxiliary requests (title/compaction) in an orchestrator session', async () => {
    const hooks = await loadPluginWithOrchestratorSession();
    try {
      // Title/compaction requests carry their own short system and no
      // environment block.
      const system = [
        'You are a title generator. You output ONLY a thread title.',
      ];
      await hooks['experimental.chat.system.transform']?.(
        { sessionID: 'ses-orc' } as never,
        { system } as never,
      );
      expect(system[0]).not.toContain('<Role>');
      expect(system[0]).toBe(
        'You are a title generator. You output ONLY a thread title.',
      );
    } finally {
      await hooks.dispose?.();
    }
  });

  test('injects on a main chat request in an orchestrator session', async () => {
    const hooks = await loadPluginWithOrchestratorSession();
    try {
      const system = [ENV_BLOCK];
      await hooks['experimental.chat.system.transform']?.(
        { sessionID: 'ses-orc' } as never,
        { system } as never,
      );
      expect(system[0]).toContain('<Role>');
    } finally {
      await hooks.dispose?.();
    }
  });

  test('collapses the v2.0.5 identity part spliced at system[1] after the orchestrator prompt', async () => {
    // OpenCode v2.0.5 core splices a "# Your Model" identity part at
    // system[1] (packages/core/src/plugin/identity.ts). The transform
    // must keep appending the orchestrator prompt to system[0] and
    // collapse deterministically regardless.
    const hooks = await loadPluginWithOrchestratorSession();
    try {
      const system = [
        'You are an agent powered by OpenCode.\n<env>Working directory: /tmp</env>',
        '# Your Model\n- Name: GLM\n- Provider ID: zhipuai\n- Model ID: glm-5.3',
      ];
      await hooks['experimental.chat.system.transform']?.(
        { sessionID: 'ses-orc', agent: 'orchestrator' } as never,
        { system } as never,
      );
      expect(system).toHaveLength(1);
      expect(system[0]).toContain('# Your Model');
      const identityAt = (system[0] as string).indexOf('# Your Model');
      const orchestratorAt = (system[0] as string).indexOf('<Role>');
      expect(orchestratorAt).toBeGreaterThan(-1);
      expect(identityAt).toBeGreaterThan(orchestratorAt);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('request-scoped agent overrides session tracking', async () => {
    const hooks = await loadPluginWithOrchestratorSession();
    try {
      // v2 bridge forwards the request agent: an auxiliary request says
      // its real agent even though the session is tracked as orchestrator.
      const system = [ENV_BLOCK];
      await hooks['experimental.chat.system.transform']?.(
        { sessionID: 'ses-orc', agent: 'title' } as never,
        { system } as never,
      );
      expect(system[0]).not.toContain('<Role>');
    } finally {
      await hooks.dispose?.();
    }
  });
});

describe('plugin foreground fallback host gating', () => {
  let originalEnv: typeof process.env;
  let projectDir: string;

  const V2_NOTICE =
    '[foreground-fallback] v2 replay fallback disabled (no atomic per-turn model switch); retry-hook steering active';

  const createFallbackClient = () => {
    const noop = async () => ({});
    const messages = mock(async () => ({ data: [] }));
    const abort = mock(async () => ({}));
    const promptAsync = mock(async () => ({}));
    const session = new Proxy(
      { messages, abort, promptAsync, get: noop, status: noop },
      { get: (target, key) => Reflect.get(target, key) ?? noop },
    );
    const client = new Proxy(
      { app: { log: noop }, session },
      {
        get: (target, key) =>
          Reflect.get(target, key) ?? new Proxy({}, { get: () => noop }),
      },
    );
    return { client, messages, abort, promptAsync };
  };

  const createHooks = (hostFlavor?: string) =>
    plugin({
      client: createFallbackClient().client,
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
      ...(hostFlavor ? { hostFlavor } : {}),
    } as never);

  const _publishCompactionRequest = async (
    hooks: Awaited<ReturnType<typeof plugin>>,
    sessionID: string,
    model: { providerID: string; modelID: string },
  ) => {
    await hooks.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_compaction',
            sessionID,
            role: 'user',
            agent: 'orchestrator',
            model,
            time: { created: 2 },
          },
        },
      },
    } as never);
    await hooks.event?.({
      event: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_compaction',
            messageID: 'msg_compaction',
            sessionID,
            type: 'compaction',
            auto: true,
          },
        },
      },
    } as never);
  };

  beforeEach(async () => {
    originalEnv = { ...process.env };
    projectDir = await mkdtemp(
      path.join(os.tmpdir(), 'oh-my-opencode-slim-fallback-gate-'),
    );
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: projectDir,
      XDG_CONFIG_HOME: projectDir,
      XDG_DATA_HOME: `${projectDir}/data`,
      XDG_CACHE_HOME: `${projectDir}/cache`,
      OPENCODE_LOG_DIR: `${projectDir}/logs`,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: { enabled: false },
        fallback: { enabled: true, maxRetries: 0 },
        agents: {
          orchestrator: { model: ['openai/gpt-b', 'openai/gpt-c'] },
        },
      }),
    );
  });

  afterEach(async () => {
    jest.useRealTimers();
    process.env = originalEnv;
    await rm(projectDir, { recursive: true, force: true });
  });

  test('v2 external admission preserves the host retry budget', async () => {
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: { enabled: false },
        fallback: { enabled: true, maxRetries: 1 },
        agents: { orchestrator: { model: ['openai/gpt-b', 'openai/gpt-c'] } },
      }),
    );
    const hooks = await createHooks('v2');
    const switchModel = mock(async () => ({}));
    const sessionID = 'v2-retry-admission';
    const model = { providerID: 'openai', modelID: 'gpt-b' };
    const retry = () => ({
      sessionID,
      agent: 'orchestrator',
      model: { providerID: 'openai', id: 'gpt-b' },
      error: { message: 'rate limit' },
      decision: { retry: true, delay: 2_000 },
    });
    try {
      await hooks.config?.({ agent: {} });
      await hooks['v2.session.retry']?.(retry() as never, switchModel as never);
      expect(switchModel).not.toHaveBeenCalled();
      await hooks['chat.message']?.(
        {
          sessionID,
          messageID: 'msg_new',
          agent: 'orchestrator',
          model,
        } as never,
        {
          message: { id: 'msg_new', sessionID, role: 'user', model },
          parts: [],
        } as never,
      );
      await hooks['v2.session.retry']?.(retry() as never, switchModel as never);
      expect(switchModel).toHaveBeenCalledTimes(1);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('v2 host: the replay path stays disabled', async () => {
    const captured: string[] = [];
    const capture = spyOn(loggerModule, 'log').mockImplementation(
      (message: string) => {
        captured.push(message);
      },
    );
    try {
      const { client, abort, promptAsync } = createFallbackClient();
      const hooks = await plugin({
        client,
        directory: projectDir,
        worktree: projectDir,
        serverUrl: new URL('http://127.0.0.1:4096'),
        hostFlavor: 'v2',
      } as never);

      // The startup notice is emitted exactly once.
      expect(captured.filter((message) => message === V2_NOTICE)).toHaveLength(
        1,
      );

      const switchModel = mock(async () => ({}));
      await hooks.event?.({
        event: {
          type: 'session.error',
          properties: {
            sessionID: 'sess-v2-gate',
            error: { message: 'Rate limit exceeded' },
          },
        },
      } as never);
      await hooks.event?.({
        event: {
          type: 'message.updated',
          properties: {
            info: {
              sessionID: 'sess-v2-gate',
              id: 'm-v2-gate',
              agent: 'orchestrator',
              role: 'assistant',
              providerID: 'openai',
              modelID: 'gpt-b',
              error: { message: 'Rate limit exceeded' },
            },
          },
        },
      } as never);
      await hooks.event?.({
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'sess-v2-gate',
            status: {
              type: 'retry',
              attempt: 1,
              message: 'rate limit, retrying...',
            },
          },
        },
      } as never);

      // No replay intervention on v2: the host has no atomic per-turn
      // conditional switch, so abort + re-prompt stays off there.
      expect(switchModel).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
      expect(promptAsync).not.toHaveBeenCalled();

      await hooks.dispose?.();
    } finally {
      capture.mockRestore();
    }
  });

  test('v2 host: retry-hook steering advances the chain in place', async () => {
    const { client, abort, promptAsync } = createFallbackClient();
    const hooks = await plugin({
      client,
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
      hostFlavor: 'v2',
    } as never);

    try {
      // The beforeEach fixture configures maxRetries: 0, so the first
      // failover retry event switches immediately — no host retries
      // absorbed, no replay.
      const switchModel = mock(async () => ({}));
      const retryEvent = {
        sessionID: 'sess-v2-steer',
        agent: 'orchestrator',
        model: { providerID: 'openai', id: 'gpt-b' },
        error: { message: 'Rate limit exceeded' },
        decision: { retry: true, delay: 2_000 },
      };
      await hooks['v2.session.retry']?.(
        retryEvent as never,
        switchModel as never,
      );
      expect(switchModel).toHaveBeenCalledTimes(1);
      expect(switchModel).toHaveBeenCalledWith('sess-v2-steer', {
        providerID: 'openai',
        id: 'gpt-c',
      });
      // The host is told to retry the current turn on the new model.
      expect(retryEvent.decision).toEqual({ retry: true, delay: 500 });
      // Steering never replays: the replay transport stays untouched.
      expect(abort).not.toHaveBeenCalled();
      expect(promptAsync).not.toHaveBeenCalled();
    } finally {
      await hooks.dispose?.();
    }
  });

  test('disabled_hooks foreground-fallback performs no automatic intervention', async () => {
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: { enabled: false },
        disabled_hooks: ['foreground-fallback'],
        fallback: { enabled: true, maxRetries: 0 },
        agents: {
          orchestrator: { model: ['openai/gpt-b', 'openai/gpt-c'] },
        },
      }),
    );
    const { client, abort, promptAsync } = createFallbackClient();
    const hooks = await plugin({
      client,
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

    try {
      await hooks.event?.({
        event: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'assistant-disabled-hook',
              sessionID: 'session-disabled-hook',
              role: 'assistant',
              agent: 'orchestrator',
              providerID: 'openai',
              modelID: 'gpt-b',
            },
          },
        },
      } as never);
      await hooks.event?.({
        event: {
          type: 'session.error',
          properties: {
            sessionID: 'session-disabled-hook',
            info: { id: 'assistant-disabled-hook' },
            error: { message: 'rate limit' },
          },
        },
      } as never);

      // The v2 retry-hook steering follows the same switch: disabled_hooks
      // must leave the host decision untouched even with a configured
      // chain and maxRetries: 0.
      const switchModel = mock(async () => ({}));
      const retryEvent = {
        sessionID: 'session-disabled-hook',
        agent: 'orchestrator',
        model: { providerID: 'openai', id: 'gpt-b' },
        error: { message: 'rate limit' },
        decision: { retry: true, delay: 2_000 },
      };
      await hooks['v2.session.retry']?.(
        retryEvent as never,
        switchModel as never,
      );
      expect(switchModel).not.toHaveBeenCalled();
      expect(retryEvent.decision).toEqual({ retry: true, delay: 2_000 });
      expect(abort).not.toHaveBeenCalled();
      expect(promptAsync).not.toHaveBeenCalled();
    } finally {
      await hooks.dispose?.();
    }
  });

  test('v2 refusal continuation yields to an external prompt but not internal discovery', async () => {
    const { client, promptAsync } = createFallbackClient();
    client.session.get = mock(async () => ({
      data: {
        agent: 'orchestrator',
        model: { providerID: 'openai', id: 'gpt-b' },
      },
    }));
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const switchModel = mock((sessionID: string) =>
      sessionID === 'epoch-internal' ? first.promise : second.promise,
    );
    const hooks = await plugin({
      client,
      directory: projectDir,
      worktree: projectDir,
      hostFlavor: 'v2',
      experimental_v2: { switchModel },
    } as never);
    jest.useFakeTimers();
    const settle = async () => {
      for (let i = 0; i < 40; i++) await Promise.resolve();
    };
    const start = async (sessionID: string) => {
      const data = {
        sessionID,
        assistantMessageID: `assistant-${sessionID}`,
        agent: 'orchestrator',
        model: { providerID: 'openai', id: 'gpt-b' },
      };
      await hooks.event?.({
        event: { type: 'session.step.started', data },
      } as never);
      await hooks.event?.({
        event: {
          type: 'session.step.failed',
          data: {
            ...data,
            finish: 'content-filter',
            error: { type: 'provider.content-filter', message: 'blocked' },
          },
        },
      } as never);
      await settle();
    };
    try {
      await start('epoch-internal');
      expect(switchModel).toHaveBeenCalledTimes(1);
      await hooks['chat.message']?.(
        { sessionID: 'epoch-internal', agent: 'orchestrator' } as never,
        { parts: [createInternalAgentTextPart('internal wake')] } as never,
      );
      await hooks['chat.message']?.(
        { sessionID: 'epoch-internal', agent: 'orchestrator' } as never,
        {} as never,
      );
      first.resolve();
      await settle();
      expect(promptAsync).toHaveBeenCalledTimes(1);
      await start('epoch-external');
      expect(switchModel).toHaveBeenCalledTimes(2);
      await hooks['chat.message']?.(
        {
          sessionID: 'epoch-external',
          agent: 'orchestrator',
          parts: [{ type: 'text', text: 'new turn' }],
        } as never,
        {} as never,
      );
      second.resolve();
      await settle();
      expect(promptAsync).toHaveBeenCalledTimes(1);
    } finally {
      first.resolve();
      second.resolve();
      await hooks.dispose?.();
    }
  });

  test('v2 retry follows the failing agent and retains it for compaction', async () => {
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: { enabled: false },
        fallback: { enabled: true, maxRetries: 0 },
        agents: {
          orchestrator: { model: ['openai/gpt-b', 'openai/gpt-c'] },
          oracle: { model: ['openai/gpt-b', 'anthropic/claude-backup'] },
        },
      }),
    );
    const hooks = await createHooks('v2');
    const switchModel = mock(async () => ({}));
    try {
      await hooks['chat.message']?.(
        {
          sessionID: 'changed-agent',
          agent: 'orchestrator',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        } as never,
        {} as never,
      );
      await hooks['v2.session.retry']?.(
        {
          sessionID: 'changed-agent',
          agent: 'oracle',
          model: { providerID: 'openai', id: 'gpt-b' },
          error: { type: 'provider.rate-limit', message: 'rate limit' },
          decision: { retry: false },
        } as never,
        switchModel as never,
      );
      expect(switchModel).toHaveBeenCalledWith('changed-agent', {
        providerID: 'anthropic',
        id: 'claude-backup',
      });

      await hooks['chat.message']?.(
        {
          sessionID: 'compaction-agent',
          agent: 'orchestrator',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        } as never,
        {} as never,
      );
      await hooks['v2.session.retry']?.(
        {
          sessionID: 'compaction-agent',
          agent: 'compaction',
          model: { providerID: 'openai', id: 'gpt-b' },
          error: { type: 'provider.rate-limit', message: 'rate limit' },
          decision: { retry: false },
        } as never,
        switchModel as never,
      );
      expect(switchModel).toHaveBeenCalledWith('compaction-agent', {
        providerID: 'openai',
        id: 'gpt-c',
      });
    } finally {
      await hooks.dispose?.();
    }
  });

  test('v2 refusal selects the chain of the started step agent', async () => {
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: { enabled: false },
        fallback: { enabled: true, maxRetries: 0 },
        agents: {
          orchestrator: { model: ['openai/gpt-b', 'openai/gpt-c'] },
          oracle: { model: ['openai/gpt-b', 'anthropic/claude-backup'] },
        },
      }),
    );
    const { client, promptAsync } = createFallbackClient();
    client.session.get = mock(async () => ({
      data: { agent: 'oracle', model: { providerID: 'openai', id: 'gpt-b' } },
    }));
    const switchModel = mock(async () => ({}));
    const hooks = await plugin({
      client,
      directory: projectDir,
      worktree: projectDir,
      hostFlavor: 'v2',
      experimental_v2: { switchModel },
    } as never);
    try {
      await hooks['chat.message']?.(
        {
          sessionID: 'changed-refusal-agent',
          agent: 'orchestrator',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        } as never,
        {} as never,
      );
      const data = {
        sessionID: 'changed-refusal-agent',
        assistantMessageID: 'assistant-refused',
        agent: 'oracle',
        model: { providerID: 'openai', id: 'gpt-b' },
      };
      await hooks.event?.({
        event: { type: 'session.step.started', data },
      } as never);
      await hooks.event?.({
        event: {
          type: 'session.step.failed',
          data: {
            ...data,
            finish: 'content-filter',
            error: { type: 'provider.content-filter', message: 'blocked' },
          },
        },
      } as never);
      // The refusal outcome is created by the failed step event itself; the
      // pending-outcome read only observes it.
      const pending = hooks['v2.pendingRefusalOutcome']?.(
        data.sessionID,
        data.assistantMessageID,
      );
      expect(pending).toBeDefined();
      expect(await pending).toBe('anthropic/claude-backup');
      expect(switchModel).toHaveBeenCalledWith(data.sessionID, {
        providerID: 'anthropic',
        id: 'claude-backup',
      });
      expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({
        body: { agent: 'oracle' },
      });
    } finally {
      await hooks.dispose?.();
    }
  });

  test('v2 retry projects the fallback model and variant without another external prompt', async () => {
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: { enabled: false },
        fallback: { enabled: true, maxRetries: 0 },
        agents: {
          orchestrator: {
            model: ['openai/gpt-b', { id: 'openai/gpt-c', variant: 'high' }],
          },
        },
      }),
    );
    const hooks = await createHooks('v2');
    try {
      await hooks['chat.message']?.(
        {
          sessionID: 'sidebar-switch',
          agent: 'orchestrator',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        } as never,
        {} as never,
      );
      const switchModel = mock(async () => ({}));
      await hooks['v2.session.retry']?.(
        {
          sessionID: 'sidebar-switch',
          agent: 'orchestrator',
          model: { providerID: 'openai', id: 'gpt-b' },
          error: { message: 'rate limit' },
          decision: { retry: false },
        } as never,
        switchModel as never,
      );
      expect(switchModel).toHaveBeenCalledTimes(1);
      expect(
        readTuiSnapshot(projectDir).sessionModels?.['sidebar-switch']
          ?.orchestrator,
      ).toEqual({ model: 'openai/gpt-c', variant: 'high' });
      const { recordInternalAdmission } = await import(
        './v2/internal-admissions'
      );
      recordInternalAdmission('sidebar-switch', 'internal-discovery');
      await hooks['chat.message']?.(
        {
          sessionID: 'sidebar-switch',
          agent: 'orchestrator',
          messageID: 'internal-discovery',
          model: { providerID: 'openai', modelID: 'gpt-b' },
        } as never,
        {} as never,
      );
      expect(
        readTuiSnapshot(projectDir).sessionModels?.['sidebar-switch']
          ?.orchestrator?.model,
      ).toBe('openai/gpt-c');
    } finally {
      await hooks.dispose?.();
    }
  });

  test('message updates preserve the selected variant until the model or variant changes', async () => {
    const configPath = `${projectDir}/oh-my-opencode-slim.json`;
    const config = await Bun.file(configPath).json();
    config.agents.orchestrator.variant = 'medium';
    config.agents.orchestrator.model = [
      'openai/gpt-b',
      { id: 'openai/gpt-c', variant: 'low' },
    ];
    await Bun.write(configPath, JSON.stringify(config));
    const hooks = await createHooks('v1');
    const sessionID = 'selected-variant';
    const info = {
      sessionID,
      role: 'assistant',
      agent: 'orchestrator',
      providerID: 'openai',
      modelID: 'gpt-b',
    };
    const observation = () =>
      readTuiSnapshot(projectDir).sessionModels?.[sessionID]?.orchestrator;
    try {
      await hooks['chat.message']?.(
        {
          sessionID,
          agent: 'orchestrator',
          model: { providerID: 'openai', modelID: 'gpt-b' },
          variant: 'high',
        } as never,
        {} as never,
      );
      await hooks.event?.({
        event: { type: 'message.updated', properties: { info } },
      } as never);
      expect(observation()).toEqual({ model: 'openai/gpt-b', variant: 'high' });
      await hooks.event?.({
        event: {
          type: 'message.updated',
          properties: { info: { ...info, variant: 'low' } },
        },
      } as never);
      expect(observation()?.variant).toBe('low');
      await hooks.event?.({
        event: {
          type: 'message.updated',
          properties: { info: { ...info, modelID: 'gpt-c' } },
        },
      } as never);
      expect(observation()).toEqual({ model: 'openai/gpt-c', variant: 'low' });
    } finally {
      await hooks.dispose?.();
    }
  });

  test('v2 host with fallback explicitly disabled: no notice, no steering', async () => {
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: { enabled: false },
        fallback: { enabled: false },
        agents: {
          orchestrator: { model: ['openai/gpt-b', 'openai/gpt-c'] },
        },
      }),
    );
    const captured: string[] = [];
    const capture = spyOn(loggerModule, 'log').mockImplementation(
      (message: string) => {
        captured.push(message);
      },
    );
    try {
      const hooks = await createHooks('v2');
      expect(captured.filter((message) => message === V2_NOTICE)).toHaveLength(
        0,
      );
      // Steering follows the same user switch: a configured chain must not
      // make the retry hook act when fallback is disabled.
      const switchModel = mock(async () => ({}));
      const retryEvent = {
        sessionID: 'sess-v2-off',
        agent: 'orchestrator',
        model: { providerID: 'openai', id: 'gpt-b' },
        error: { message: 'Rate limit exceeded' },
        decision: { retry: true, delay: 2_000 },
      };
      await hooks['v2.session.retry']?.(
        retryEvent as never,
        switchModel as never,
      );
      expect(switchModel).not.toHaveBeenCalled();
      expect(retryEvent.decision).toEqual({ retry: true, delay: 2_000 });
      await hooks.dispose?.();
    } finally {
      capture.mockRestore();
    }
  });

  test('v2 host with foreground-fallback hook disabled: no notice, no steering', async () => {
    await Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({
        companion: { enabled: false },
        disabled_hooks: ['foreground-fallback'],
        fallback: { enabled: true },
        agents: {
          orchestrator: { model: ['openai/gpt-b', 'openai/gpt-c'] },
        },
      }),
    );
    const captured: string[] = [];
    const capture = spyOn(loggerModule, 'log').mockImplementation(
      (message: string) => {
        captured.push(message);
      },
    );
    try {
      const hooks = await createHooks('v2');
      expect(captured.filter((message) => message === V2_NOTICE)).toHaveLength(
        0,
      );
      // disabled_hooks gates steering identically to fallback.enabled.
      const switchModel = mock(async () => ({}));
      const retryEvent = {
        sessionID: 'sess-v2-hook-off',
        agent: 'orchestrator',
        model: { providerID: 'openai', id: 'gpt-b' },
        error: { message: 'Rate limit exceeded' },
        decision: { retry: true, delay: 2_000 },
      };
      await hooks['v2.session.retry']?.(
        retryEvent as never,
        switchModel as never,
      );
      expect(switchModel).not.toHaveBeenCalled();
      expect(retryEvent.decision).toEqual({ retry: true, delay: 2_000 });
      await hooks.dispose?.();
    } finally {
      capture.mockRestore();
    }
  });
});

describe('plugin command registration gating', () => {
  let originalEnv: typeof process.env;
  let projectDir: string;

  const createClient = () => {
    const noop = async () => ({});
    const session = new Proxy({}, { get: () => noop }) as Record<
      string,
      unknown
    >;
    return new Proxy(
      { app: { log: noop }, session },
      {
        get(target, property) {
          if (property in target) {
            return target[property as keyof typeof target];
          }
          return new Proxy({}, { get: () => noop });
        },
      },
    );
  };

  const writeConfig = (config: Record<string, unknown>) =>
    Bun.write(
      `${projectDir}/oh-my-opencode-slim.json`,
      JSON.stringify({ companion: { enabled: false }, ...config }),
    );

  const createHooks = async () =>
    plugin({
      client: createClient(),
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as never);

  const _prepareCommands = async (): Promise<Record<string, unknown>> => {
    const hooks = await createHooks();
    try {
      const draft: Record<string, unknown> = { agent: {}, mcp: {} };
      (
        hooks as unknown as { registryBridge: RegistryFactoryBridge }
      ).registryBridge.prepareCommands(draft);
      return (draft.command as Record<string, unknown> | undefined) ?? {};
    } finally {
      await hooks.dispose?.();
    }
  };

  beforeEach(async () => {
    originalEnv = { ...process.env };
    projectDir = await mkdtemp(
      path.join(os.tmpdir(), 'oh-my-opencode-slim-command-gate-'),
    );
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: projectDir,
      XDG_CONFIG_HOME: projectDir,
      XDG_DATA_HOME: `${projectDir}/data`,
      XDG_CACHE_HOME: `${projectDir}/cache`,
      OPENCODE_LOG_DIR: `${projectDir}/logs`,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(projectDir, { recursive: true, force: true });
  });

  test('disabled commands stay execution-inert while enabled ones intercept', async () => {
    await writeConfig({ disabled_commands: ['deepwork'] });
    const hooks = await createHooks();
    try {
      // Mirror the host order: the config hook registers commands before
      // any command executes, so an enabled command is armed.
      (
        hooks as unknown as { registryBridge: RegistryFactoryBridge }
      ).registryBridge.prepareCommands({ agent: {}, mcp: {} });

      // A user-defined command with the same name must not be rewritten by
      // the disabled omos workflow (the twin of the registration gate).
      const userOwnedOutput = {
        parts: [{ type: 'text', text: 'user-owned /deepwork output' }],
      };
      await hooks['command.execute.before']?.(
        {
          command: 'deepwork',
          sessionID: 'sess-command-gate',
          arguments: 'do work',
        } as never,
        userOwnedOutput as never,
      );
      expect(userOwnedOutput.parts).toEqual([
        { type: 'text', text: 'user-owned /deepwork output' },
      ]);

      // Negative control: an enabled command is still intercepted.
      const enabledOutput = {
        parts: [] as Array<{ type: string; text?: string }>,
      };
      await hooks['command.execute.before']?.(
        {
          command: 'reflect',
          sessionID: 'sess-command-gate',
          arguments: '',
        } as never,
        enabledOutput as never,
      );
      expect(enabledOutput.parts.length).toBeGreaterThan(0);
    } finally {
      await hooks.dispose?.();
    }
  });
});
