/**
 * End-to-end coverage for `createV2Setup()` against a hand-written mock
 * V2Context: factory init → all registrations → bridge interactions →
 * graceful degradation → dispose.
 *
 * Mock design:
 * - Every ctx domain (agent/tool/command/session/mcp/event/generate/
 *   location) is a programmable capture: draft methods record calls, hook
 *   registrations capture callbacks, transforms return disposables.
 * - `event.subscribe()` returns a test-controlled async iterator (manual
 *   push, pull counter, return() tracking).
 * - The v1 factory runs for real against a minimal temp-dir fixture
 *   (empty plugin config, companion disabled), mirroring src/index.test.ts.
 *
 * Assertion approaches (documented per the plan):
 * - Job-board side effects are observed through the board's public tool
 *   surface: the `task_status` v2 tool captured from the tool draft.
 * - Event-pump mapping is proven name-specifically via cache-monitor: only
 *   the SYNTHESIZED `message.updated` (from v2 `session.usage.updated`) can
 *   trip its bust warning, which is written to the plugin log
 *   (`OPENCODE_LOG_DIR` fixture + `flushLoggerForTesting`).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync as readDirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { MarketplaceStore } from '../marketplace/store';
import { flushLoggerForTesting } from '../utils/logger';
import { compilePermissionPolicy } from './permissions';
import {
  createV2Setup,
  snapshotV2HostAgents,
  V2AgentRegistryNotReadyError,
} from './setup';
import type { V2Context, V2PermissionRule } from './types';

type CapturedTool = {
  name: string;
  options?: { codemode?: boolean };
  execute: (input: unknown, context: unknown) => Promise<unknown>;
};

interface MockCalls {
  agentUpdates: Array<{ id: string }>;
  agentConfigs: Map<string, Record<string, unknown>>;
  agentDefault: string | undefined;
  agentTransformCount: number;
  toolAdds: CapturedTool[];
  commandAdds: Array<{ name: string; definition: Record<string, unknown> }>;
  mcpSets: Array<{ name: string; config: Record<string, unknown> }>;
  mcpDraftSnapshots: string[][];
  hooks: string[];
  toolBeforeCb:
    | ((event: Record<string, unknown> & { input: unknown }) => Promise<void>)
    | undefined;
  toolAfterCb:
    | ((event: Record<string, unknown> & { result?: unknown }) => Promise<void>)
    | undefined;
  contextHookCb:
    | ((event: Record<string, unknown>) => Promise<void>)
    | undefined;
  pendingMcpCallback?: (draft: unknown) => void;
  disposed: string[];
}

/** Test-controlled event stream: manual push, pull/return observability. */
function createEventQueue() {
  const pending: Array<Record<string, unknown>> = [];
  let resolveNext:
    | ((r: IteratorResult<Record<string, unknown>>) => void)
    | undefined;
  let returnCalled = false;
  let pulled = 0;

  const iterator: AsyncIterator<Record<string, unknown>> = {
    next: () => {
      if (pending.length > 0) {
        pulled += 1;
        return Promise.resolve({
          value: pending.shift() as Record<string, unknown>,
          done: false,
        });
      }
      if (returnCalled) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    },
    return: () => {
      returnCalled = true;
      resolveNext?.({ value: undefined, done: true });
      resolveNext = undefined;
      pending.length = 0;
      return Promise.resolve({ value: undefined, done: true });
    },
  };

  return {
    iterable: {
      [Symbol.asyncIterator]: () => iterator,
    },
    push(event: Record<string, unknown>): void {
      if (returnCalled) return; // pump closed — dropped
      const resolve = resolveNext;
      resolveNext = undefined;
      if (resolve) {
        pulled += 1;
        resolve({ value: event, done: false });
      } else {
        pending.push(event);
      }
    },
    pulled: () => pulled,
    isReturnCalled: () => returnCalled,
    pendingCount: () => pending.length,
  };
}

function makeMockV2Context(
  projectDir: string,
  nativeAgents: Record<string, Record<string, unknown>> = {},
  options: {
    invokeAgentCallback?: boolean;
    replayAgentCallback?: boolean;
    nativeMcps?: Record<string, Record<string, unknown>>;
    delayMcpRegistration?: boolean;
    delayFirstMcpCallback?: boolean;
    mcpTransform?: 'unavailable' | 'throws';
  } = {},
): {
  ctx: V2Context;
  calls: MockCalls;
  events: ReturnType<typeof createEventQueue>;
} {
  const calls: MockCalls = {
    agentUpdates: [],
    agentConfigs: new Map(),
    agentDefault: undefined,
    agentTransformCount: 0,
    toolAdds: [],
    commandAdds: [],
    mcpSets: [],
    mcpDraftSnapshots: [],
    hooks: [],
    toolBeforeCb: undefined,
    toolAfterCb: undefined,
    contextHookCb: undefined,
    disposed: [],
  };
  const events = createEventQueue();
  let mcpTransformCount = 0;
  const reg = (label: string) => ({
    dispose: () => {
      calls.disposed.push(label);
    },
  });

  const ctx = {
    app: { name: 'opencode', version: 'v2-e2e' },
    options: {},
    location: {
      directory: projectDir,
      project: {
        id: 'proj_e2e',
        directory: projectDir,
        canonical: projectDir,
      },
    },
    agent: {
      transform: async (cb: (draft: unknown) => void) => {
        calls.agentTransformCount += 1;
        const draft = {
          list: () =>
            Object.entries(nativeAgents).map(([id, config]) => ({
              id,
              ...config,
            })),
          get: (id: string) => nativeAgents[id],
          default: (id: string | undefined) => {
            calls.agentDefault = id;
          },
          update: (id: string, fn: (agent: unknown) => void) => {
            calls.agentUpdates.push({ id });
            const config = calls.agentConfigs.get(id) ?? {
              ...(nativeAgents[id] ?? {}),
            };
            fn(config);
            calls.agentConfigs.set(id, config);
          },
          remove: () => {},
        };
        if (options.invokeAgentCallback !== false) cb(draft);
        if (options.replayAgentCallback) {
          const hostPermissions = nativeAgents.orchestrator?.permissions;
          if (Array.isArray(hostPermissions)) {
            hostPermissions.splice(0, hostPermissions.length, {
              action: '*',
              resource: '*',
              effect: 'deny',
            });
          }
          nativeAgents.orchestrator = {
            ...(nativeAgents.orchestrator ?? {}),
            model: { id: 'mutated-marketplace-model', providerID: 'changed' },
          };
          cb(draft);
        }
        return reg(`agent:${calls.agentTransformCount}`);
      },
      reload: async () => ({}),
      list: async () => [],
    },
    tool: {
      transform: async (cb: (draft: unknown) => void) => {
        cb({
          add: (toolDef: Record<string, unknown>) => {
            calls.toolAdds.push(toolDef as unknown as CapturedTool);
          },
        });
        return reg('tool.transform');
      },
      hook: async (
        name: 'execute.before' | 'execute.after',
        cb: (event: never) => Promise<void>,
      ) => {
        calls.hooks.push(`tool:${name}`);
        if (name === 'execute.before') {
          calls.toolBeforeCb = cb as unknown as MockCalls['toolBeforeCb'];
        } else {
          calls.toolAfterCb = cb as unknown as MockCalls['toolAfterCb'];
        }
        return reg(`tool.hook:${name}`);
      },
    },
    command: {
      transform: async (cb: (draft: unknown) => void) => {
        cb({
          add: (definition: Record<string, unknown>) => {
            calls.commandAdds.push({
              name: definition.name as string,
              definition,
            });
          },
        });
        return reg(`command:${calls.commandAdds.length}`);
      },
      list: async () => [],
    },
    // Runtime session methods deliberately ABSENT: the shim must degrade
    // honestly without them (no fake success shapes).
    session: {
      hook: async (name: 'context', cb: (event: never) => Promise<void>) => {
        calls.hooks.push(`session:${name}`);
        if (name === 'context') {
          calls.contextHookCb = cb as unknown as MockCalls['contextHookCb'];
        }
        return reg(`session.hook:${name}`);
      },
    },
    mcp: {
      transform: async (cb: (draft: unknown) => void) => {
        if (options.mcpTransform === 'throws') {
          throw new Error('host MCP transform registration failed');
        }
        mcpTransformCount += 1;
        const draft = {
          list: () => {
            const entries = Object.entries(options.nativeMcps ?? {});
            calls.mcpDraftSnapshots.push(entries.map(([name]) => name));
            return entries;
          },
          get: (name: string) => options.nativeMcps?.[name],
          set: (name: string, config: Record<string, unknown>) => {
            calls.mcpSets.push({ name, config });
          },
          update: () => {},
          remove: () => {},
        };
        if (
          (options.delayFirstMcpCallback || options.delayMcpRegistration) &&
          mcpTransformCount === 1
        ) {
          calls.pendingMcpCallback = cb;
        } else {
          cb(draft);
        }
        return reg('mcp.transform');
      },
      reload: async () => {},
    },
    event: {
      subscribe: () => events.iterable,
    },
    generate: {
      text: async (input: { prompt: string }) => ({
        text: `generated:${input.prompt}`,
      }),
    },
  } as unknown as V2Context;
  if (options.mcpTransform === 'unavailable') {
    delete (ctx as { mcp?: V2Context['mcp'] }).mcp;
  }

  return { ctx, calls, events };
}

function effectiveRule(
  rules: readonly V2PermissionRule[],
  action: string,
  resource: string,
): V2PermissionRule['effect'] {
  return (
    rules.findLast(
      (rule) =>
        permissionPatternMatches(action, rule.action) &&
        permissionPatternMatches(resource, rule.resource),
    )?.effect ?? 'ask'
  );
}

function permissionPatternMatches(value: string, pattern: string): boolean {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  return new RegExp(`^${expression}$`, 's').test(value);
}

/** v2 usage telemetry event (cache-monitor bust signature). */
function v2UsageEvent(
  sessionID: string,
  tokens: { input: number; read: number; write?: number },
): Record<string, unknown> {
  return {
    type: 'session.usage.updated',
    properties: {
      sessionID,
      tokens: {
        input: tokens.input,
        output: 5,
        reasoning: 0,
        cache: { read: tokens.read, write: tokens.write ?? 0 },
      },
    },
  };
}

describe('createV2Setup e2e', () => {
  let originalEnv: typeof process.env;
  let fixtureRoot: string;
  let projectDir: string;
  let configDir: string;
  let logDir: string;

  const readPluginLog = (): string => {
    const files = readDirSync(logDir).filter(
      (f) => f.startsWith('oh-my-opencode-slim.') && f.endsWith('.log'),
    );
    return files
      .map((f) => readFileSync(path.join(logDir, f), 'utf8'))
      .join('');
  };

  const settlePump = async (ms = 50): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await flushLoggerForTesting();
  };

  beforeEach(async () => {
    originalEnv = { ...process.env };
    fixtureRoot = await mkdtemp('/tmp/omo-v2-setup-e2e-');
    projectDir = path.join(fixtureRoot, 'project');
    configDir = path.join(fixtureRoot, 'config');
    logDir = path.join(fixtureRoot, 'logs');
    await Bun.write(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      // Minimal fixture: empty plugin config with the companion disabled so
      // factory init stays hermetic (no user config, no side processes).
      JSON.stringify({ companion: { enabled: false } }),
    );
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_CONFIG_HOME: path.join(fixtureRoot, 'xdg-config'),
      XDG_DATA_HOME: path.join(fixtureRoot, 'xdg-data'),
      XDG_CACHE_HOME: path.join(fixtureRoot, 'xdg-cache'),
      OPENCODE_LOG_DIR: logDir,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  test('registers agents, tools, commands, mcp, and hooks on a full ctx', async () => {
    const { ctx, calls } = makeMockV2Context(projectDir);
    const cleanup = await createV2Setup()(ctx);

    expect(calls.agentUpdates.map((u) => u.id)).toContain('orchestrator');
    expect(calls.agentDefault).toBe('orchestrator');
    expect(calls.toolAdds.length).toBeGreaterThan(0);
    // CodeMode split (upstream Tool.snapshot): every registered tool must
    // carry `options: { codemode: false }` or it never becomes a direct
    // model-visible tool definition — it lands in the `execute` tool's
    // confined JS runtime and session catalogs yield `Unknown tool: ...`.
    for (const tool of calls.toolAdds) {
      expect(tool.options).toEqual({ codemode: false });
    }
    expect(calls.commandAdds.map((c) => c.name)).toContain('deepwork');
    expect(calls.mcpSets.map((m) => m.name)).toEqual(['context7', 'gh_grep']);
    expect(calls.mcpSets.map((m) => m.config)).toEqual([
      expect.objectContaining({ type: 'remote' }),
      expect.objectContaining({ type: 'remote' }),
    ]);
    expect(calls.hooks).toContain('session:context');
    expect(calls.hooks).toContain('session:prompt');
    expect(calls.hooks).toContain('tool:execute.before');
    expect(calls.hooks).toContain('tool:execute.after');
    expect(calls.contextHookCb).toBeFunction();

    await cleanup();
    expect(calls.disposed.length).toBeGreaterThan(0);
  }, 20_000);

  test('finalizes native ordered permission policy before agent projection', async () => {
    const nativePermissions = [
      { action: 'read', resource: 'src/**', effect: 'deny' },
      { action: 'read', resource: 'src/private.ts', effect: 'allow' },
    ];
    const { ctx, calls } = makeMockV2Context(projectDir, {
      orchestrator: {
        model: { id: 'host-model', providerID: 'host-provider' },
        permissions: nativePermissions,
      },
    });

    const cleanup = await createV2Setup()(ctx);
    try {
      expect(calls.agentConfigs.get('orchestrator')?.model).toEqual({
        id: 'host-model',
        providerID: 'host-provider',
      });
      const permissions = calls.agentConfigs.get('orchestrator')
        ?.permissions as V2PermissionRule[];
      expect(effectiveRule(permissions, 'read', 'src/private.ts')).toBe(
        'allow',
      );
      expect(effectiveRule(permissions, 'read', 'src/secret.ts')).toBe('deny');
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('resolves native permission snapshots for display-name aliases', async () => {
    await Bun.write(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        companion: { enabled: false },
        agents: { explorer: { displayName: 'Scout' } },
      }),
    );
    const nativePermissions = [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: 'docs/**', effect: 'allow' },
    ];
    const { ctx, calls } = makeMockV2Context(projectDir, {
      Scout: { permissions: nativePermissions },
    });

    const cleanup = await createV2Setup()(ctx);
    try {
      const rules = calls.agentConfigs.get('explorer')
        ?.permissions as V2PermissionRule[];
      expect(effectiveRule(rules, 'read', 'docs/guide.md')).toBe('allow');
      expect(effectiveRule(rules, 'edit', 'docs/guide.md')).toBe('deny');
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('marketplace ceilings deny unknown actions and skills despite host allow', () => {
    const policy = compilePermissionPolicy({
      baselineRules: [{ action: '*', resource: '*', effect: 'allow' }],
      hostRules: [{ action: '*', resource: '*', effect: 'allow' }],
      marketplace: {
        actions: { read: 'ask', skill: 'allow' },
        skills: ['known-skill'],
        mcpNamespaces: [],
      },
    });

    expect(policy.decide('read', 'src/index.ts')).toBe('ask');
    expect(policy.decide('edit', 'src/index.ts')).toBe('deny');
    expect(policy.decideSkill('known-skill')).toBe('allow');
    expect(policy.decideSkill('unknown-skill')).toBe('deny');
    expect(effectiveRule(policy.rules, 'skill', 'known-skill')).toBe(
      policy.decideSkill('known-skill'),
    );
    expect(effectiveRule(policy.rules, 'skill', 'unknown-skill')).toBe(
      policy.decideSkill('unknown-skill'),
    );
  });

  test('snapshots native model/config without flattening permission rules', () => {
    const permissions = [
      { action: 'read', resource: 'src/**', effect: 'deny' },
      { action: 'read', resource: 'src/private.ts', effect: 'allow' },
    ];
    const snapshot = snapshotV2HostAgents({
      list: () => [{ id: 'custom', model: { id: 'm', providerID: 'p' } }],
      get: () => ({
        config: { temperature: 0.2 },
        model: { id: 'm', providerID: 'p' },
        permissions,
      }),
    });

    expect(snapshot.custom).toMatchObject({
      model: 'p/m',
      temperature: 0.2,
      permissions,
    });
    expect(snapshot.custom.permissions).toBe(permissions);
  });

  test('replayed agent callbacks reuse the first finalized registry snapshot', async () => {
    const nativePermissions = [
      { action: 'read', resource: 'src/**', effect: 'deny' },
      { action: 'read', resource: 'src/private.ts', effect: 'allow' },
    ];
    const { ctx, calls } = makeMockV2Context(
      projectDir,
      {
        orchestrator: {
          model: { id: 'initial-model', providerID: 'initial-provider' },
          permissions: nativePermissions,
        },
      },
      { replayAgentCallback: true },
    );

    const cleanup = await createV2Setup()(ctx);
    try {
      expect(calls.agentConfigs.get('orchestrator')?.model).toEqual({
        id: 'initial-model',
        providerID: 'initial-provider',
      });
      const rules = calls.agentConfigs.get('orchestrator')
        ?.permissions as V2PermissionRule[];
      expect(effectiveRule(rules, 'read', 'src/private.ts')).toBe('allow');
      expect(effectiveRule(rules, 'read', 'src/secret.ts')).toBe('deny');
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('registers commands without invoking agent finalization', async () => {
    const { ctx, calls } = makeMockV2Context(
      projectDir,
      {},
      { invokeAgentCallback: false },
    );

    const cleanup = await createV2Setup()(ctx);
    try {
      expect(calls.commandAdds.map((command) => command.name)).toContain(
        'deepwork',
      );
      expect(calls.agentUpdates).toHaveLength(0);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('MCP registration does not change the configured capability snapshot', async () => {
    const { ctx, calls } = makeMockV2Context(
      projectDir,
      {},
      {
        nativeMcps: {
          custom_docs: { type: 'remote', url: 'https://docs.example.test/mcp' },
        },
        delayMcpRegistration: true,
      },
    );

    const cleanup = await createV2Setup()(ctx);
    try {
      // The registration callback never rediscovers or rewrites the frozen
      // preflight snapshot.
      expect(calls.mcpDraftSnapshots).toEqual([]);
      expect(calls.agentUpdates.map(({ id }) => id)).toContain('orchestrator');
      expect(calls.pendingMcpCallback).toBeFunction();
      calls.pendingMcpCallback?.({
        list: () => [['late_native', { type: 'remote' }]],
        get: () => undefined,
        set: (name: string, config: Record<string, unknown>) => {
          calls.mcpSets.push({ name, config });
        },
        update: () => {},
        remove: () => {},
      });
      expect(calls.mcpDraftSnapshots).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('unavailable or failing MCP transform excludes Slim built-ins but preserves host servers', async () => {
    const store = new MarketplaceStore();
    const manifest = {
      schemaVersion: 2 as const,
      id: 'community/host-docs',
      version: '1.0.0',
      displayName: 'Host docs',
      description: 'Host docs agent',
      agentName: 'hostdocs',
      prompt: 'Read docs.',
      author: { name: 'Community' },
      tags: ['docs'],
      license: 'MIT',
      compatibility: { plugin: '>=3.0.0-beta.3 <4.0.0' },
      routing: {
        description: 'Docs research',
        keywords: ['docs'],
        when: 'Docs needed',
      },
      skills: [],
      mcps: ['host_docs'],
      tools: [],
      model: { source: 'explicit' as const, candidates: ['provider/model'] },
      extends: { builtin: 'explorer' as const, promptMode: 'append' as const },
    };
    store.install({ manifest });
    store.install({
      manifest: {
        ...manifest,
        id: 'community/builtin-docs',
        agentName: 'builtindocs',
        displayName: 'Builtin docs',
        mcps: ['context7'],
      },
    });
    await Bun.write(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        companion: { enabled: false },
        preset: 'work',
        presets: {
          work: {
            marketplace: {
              agents: ['community/host-docs', 'community/builtin-docs'],
            },
          },
        },
      }),
    );
    await Bun.write(
      path.join(configDir, 'opencode.json'),
      JSON.stringify({
        mcp: {
          servers: {
            host_docs: {
              type: 'remote',
              url: 'https://docs.test',
              timeout: { startup: 1000, request: 2000 },
            },
          },
        },
      }),
    );
    for (const mcpTransform of ['unavailable', 'throws'] as const) {
      const { ctx, calls } = makeMockV2Context(
        projectDir,
        {},
        { mcpTransform },
      );
      const cleanup = await createV2Setup()(ctx);
      try {
        expect(calls.mcpSets).toEqual([]);
        expect(calls.agentConfigs.has('hostdocs')).toBe(true);
        expect(calls.agentConfigs.has('builtindocs')).toBe(false);
      } finally {
        await cleanup();
      }
    }
  }, 20_000);

  test('deferred first MCP callback preserves activation and permission projection in both orders', async () => {
    const store = new MarketplaceStore();
    store.install({
      manifest: {
        schemaVersion: 2,
        id: 'community/docs-researcher',
        version: '1.0.0',
        displayName: 'Docs researcher',
        description: 'Docs research agent',
        agentName: 'docsresearcher',
        prompt: 'Read docs.',
        author: { name: 'Community' },
        tags: ['docs'],
        license: 'MIT',
        compatibility: { plugin: '>=3.0.0-beta.3 <4.0.0' },
        routing: {
          description: 'Docs research',
          keywords: ['docs'],
          when: 'Docs needed',
        },
        skills: [],
        mcps: ['custom_docs'],
        tools: [],
        model: { source: 'explicit', candidates: ['provider/model'] },
        extends: { builtin: 'explorer', promptMode: 'append' },
      },
    });
    await Bun.write(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        companion: { enabled: false },
        preset: 'work',
        presets: {
          work: { marketplace: { agents: ['community/docs-researcher'] } },
        },
      }),
    );
    const hostConfig = path.join(configDir, 'opencode.json');
    for (const [delayFirstMcpCallback, disabledCustom] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      await Bun.write(
        hostConfig,
        JSON.stringify({
          mcp: {
            servers: {
              custom_docs: {
                type: 'remote',
                url: 'https://docs.test',
                disabled: disabledCustom,
              },
              disabled_docs: {
                type: 'remote',
                url: 'https://disabled.test',
                disabled: true,
              },
              malformed_docs: { type: 'remote' },
            },
          },
        }),
      );
      const { ctx, calls } = makeMockV2Context(
        projectDir,
        {},
        {
          delayFirstMcpCallback,
          nativeMcps: {
            late_native: { type: 'remote', url: 'https://late.test' },
          },
        },
      );
      const cleanup = await createV2Setup()(ctx);
      try {
        expect(calls.agentConfigs.has('docsresearcher')).toBe(!disabledCustom);
        const rules = calls.agentConfigs.get('docsresearcher')?.permissions as
          | V2PermissionRule[]
          | undefined;
        if (rules) {
          expect(effectiveRule(rules, 'custom_docs_*', '*')).toBe('allow');
          expect(effectiveRule(rules, 'disabled_docs_*', '*')).not.toBe(
            'allow',
          );
          expect(effectiveRule(rules, 'malformed_docs_*', '*')).not.toBe(
            'allow',
          );
          expect(effectiveRule(rules, 'late_native_*', '*')).not.toBe('allow');
        }
        if (delayFirstMcpCallback) {
          expect(calls.mcpDraftSnapshots).toEqual([]);
          calls.pendingMcpCallback?.({
            list: () => [],
            get: () => undefined,
            set: () => {},
            update: () => {},
            remove: () => {},
          });
          expect(calls.agentConfigs.get('docsresearcher')?.permissions).toEqual(
            rules,
          );
        }
      } finally {
        await cleanup();
      }
    }
  }, 20_000);

  test('MCP callback timing does not change the finalized agent permissions', async () => {
    const nativePermissions = [
      { action: 'read', resource: 'src/**', effect: 'deny' },
      { action: 'read', resource: 'src/private.ts', effect: 'allow' },
    ];
    const results: V2PermissionRule[][] = [];
    for (const delayMcpRegistration of [false, true]) {
      const { ctx, calls } = makeMockV2Context(
        projectDir,
        { orchestrator: { permissions: nativePermissions } },
        {
          nativeMcps: { custom_docs: { type: 'remote' } },
          delayMcpRegistration,
        },
      );
      const cleanup = await createV2Setup()(ctx);
      try {
        results.push(
          calls.agentConfigs.get('orchestrator')
            ?.permissions as V2PermissionRule[],
        );
        calls.pendingMcpCallback?.({
          list: () => [['late_native', { type: 'remote' }]],
          get: () => undefined,
          set: () => {},
          update: () => {},
          remove: () => {},
        });
        expect(calls.agentConfigs.get('orchestrator')?.permissions).toEqual(
          results.at(-1),
        );
      } finally {
        await cleanup();
      }
    }
    expect(results[1]).toEqual(results[0]);
  }, 20_000);

  test('context hook rejects before mutation when agent registry is not ready', async () => {
    const { ctx, calls } = makeMockV2Context(
      projectDir,
      {},
      {
        invokeAgentCallback: false,
      },
    );

    const cleanup = await createV2Setup()(ctx);
    try {
      const event = {
        sessionID: 'ses_not_ready',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'unchanged' }],
          },
        ],
        system: [{ type: 'text', text: 'system' }],
      } as never;
      const original = structuredClone(event);

      await expect(calls.contextHookCb?.(event)).rejects.toBeInstanceOf(
        V2AgentRegistryNotReadyError,
      );
      expect(event).toEqual(original);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('reduced ctx (no agent.transform) skips gracefully', async () => {
    const cleanup = await createV2Setup()({} as never);
    await cleanup(); // passes when neither call throws
  }, 20_000);

  test('subagent launch flows into the job board through the tool bridges', async () => {
    const { ctx, calls } = makeMockV2Context(projectDir);
    const cleanup = await createV2Setup()(ctx);
    try {
      // (1) v2 subagent spawn (background). The before-bridge must hand
      // the v1 hook tool 'task' with v1 args (agent→subagent_type).
      const beforeEvent = {
        tool: 'subagent',
        sessionID: 'ses_parent',
        agent: 'orchestrator',
        messageID: 'msg_1',
        id: 'call_1',
        input: {
          agent: 'fixer',
          description: 'e2e delegation',
          prompt: 'Do the work',
          background: true,
        },
      };
      const beforeHook = calls.toolBeforeCb;
      if (!beforeHook) throw new Error('tool:execute.before not captured');
      await beforeHook(beforeEvent);

      // Args write-back: v2 naming preserved, nothing invented. The v1
      // hook saw `subagent_type: 'fixer'` (proved below by the board
      // record's agent), and no v1 field names leak into the v2 input.
      expect(beforeEvent.input).toEqual({
        agent: 'fixer',
        description: 'e2e delegation',
        prompt: 'Do the work',
        background: true,
      });

      // (2) Write-back rewrite: a v2 `sessionID` that is not a
      // resolvable/valid task id maps to v1 `task_id`. Unknown aliases are
      // dropped so task() can spawn a new session instead of refusing.
      const resumeEvent = {
        tool: 'subagent',
        sessionID: 'ses_parent',
        agent: 'orchestrator',
        messageID: 'msg_1',
        id: 'call_2',
        input: {
          agent: 'fixer',
          description: 'e2e delegation 2',
          prompt: 'More work',
          background: true,
          sessionID: 'resume_me',
        },
      };
      const resumeHook = calls.toolBeforeCb;
      if (!resumeHook) throw new Error('tool:execute.before not captured');
      await resumeHook(resumeEvent);
      expect(resumeEvent.input.sessionID).toBeUndefined();

      // (3) v2 subagent result: plain-text background output. The
      // after-bridge maps content → v1 `output` under tool 'task'; the
      // v1 after-hook parses it and registers the launch on the board.
      const backgroundText =
        'The subagent is working in the background (sessionID: ses_kid_1). ' +
        'You will be notified automatically when it finishes.';
      const afterHook = calls.toolAfterCb;
      if (!afterHook) throw new Error('tool:execute.after not captured');
      await afterHook({
        tool: 'subagent',
        sessionID: 'ses_parent',
        agent: 'orchestrator',
        messageID: 'msg_1',
        id: 'call_1',
        input: beforeEvent.input,
        status: 'completed',
        result: { content: backgroundText },
      });

      // Board observable: the task_status v2 tool captured from the
      // tool draft reads the registered job through the real board.
      const taskStatus = calls.toolAdds.find((t) => t.name === 'task_status');
      if (!taskStatus) throw new Error('task_status tool not registered');
      const status = (await taskStatus.execute(
        { task_id: 'ses_kid_1' },
        { sessionID: 'ses_parent' },
      )) as { content: string };
      expect(status.content).toContain('state: running');
      // 'agent: fixer' proves the before-hook observed the v1 arg shape
      // (subagent_type derived from the v2 `agent` field).
      expect(status.content).toContain('agent: fixer');
      expect(status.content).toContain('ses_kid_1');
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('event pump maps v2 events into v1 handler shapes and stops on dispose', async () => {
    const { ctx, events } = makeMockV2Context(projectDir);
    const cleanup = await createV2Setup()(ctx);

    // Cache-monitor bust signature (see event-adapter.test.ts): only the
    // SYNTHESIZED message.updated events can trip the warning — the raw
    // v2 session.usage.updated passthrough is inert in the v1 pipeline,
    // so this assertion is name-specific to the mapping layer.
    events.push(
      v2UsageEvent('ses_cache', { input: 8000, read: 0, write: 7000 }),
    );
    events.push(v2UsageEvent('ses_cache', { input: 500, read: 9000 }));
    events.push(v2UsageEvent('ses_cache', { input: 12000, read: 0 }));

    // Terminal execution.succeeded → synthesized idle pair reaches the
    // v1 event-router (which logs the observation for any session id).
    events.push({
      type: 'session.execution.succeeded',
      properties: { sessionID: 'ses_cache' },
    });

    await settlePump();
    const logDuringRun = readPluginLog();
    expect(logDuringRun).toContain('prompt-cache bust');
    expect(logDuringRun).toContain(
      '[task-session-manager] idle/status idle observed',
    );

    const pullsAtDispose = events.pulled();
    const bustWarningsAtDispose = (
      logDuringRun.match(/prompt-cache bust/g) ?? []
    ).length;

    await cleanup();
    expect(events.isReturnCalled()).toBe(true);

    // After dispose the pump must not process further events: a fresh
    // bust sequence for a new session would add a second warning if the
    // eventHook still ran.
    events.push(
      v2UsageEvent('ses_after', { input: 8000, read: 0, write: 7000 }),
    );
    events.push(v2UsageEvent('ses_after', { input: 12000, read: 0 }));
    events.push({
      type: 'session.execution.succeeded',
      properties: { sessionID: 'ses_after' },
    });
    await settlePump();

    expect(events.pulled()).toBe(pullsAtDispose);
    const logAfterDispose = readPluginLog();
    const bustWarningsAfter = (
      logAfterDispose.match(/prompt-cache bust/g) ?? []
    ).length;
    expect(bustWarningsAfter).toBe(bustWarningsAtDispose);
    expect(logAfterDispose).not.toContain('ses_after');
  }, 20_000);

  test('event pump synthesizes session.deleted from the live `data` shape into the v1 cleanup path', async () => {
    const { ctx, events } = makeMockV2Context(projectDir);
    const cleanup = await createV2Setup()(ctx);

    try {
      // Live wire shape: payload keyed under `data` (verified live).
      // Only the SYNTHESIZED dual-spelling session.deleted
      // reaches the v1 event-router cleanup path — the raw passthrough is
      // inert there — so this log line is name-specific to the mapping.
      events.push({
        id: 'evt_session_deleted',
        created: 1_788_961_637_000,
        type: 'session.deleted',
        durable: { aggregateID: 'ses_gone', seq: 1, version: 1 },
        data: { sessionID: 'ses_gone' },
      });

      await settlePump();
      const logText = readPluginLog();
      expect(logText).toContain(
        '[task-session-manager] session.deleted observed',
      );
      expect(logText).toContain('ses_gone');
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('ctx.storage (when present) enables background-job persistence before the v1 factory runs', async () => {
    const { ctx } = makeMockV2Context(projectDir);
    // Pre-seeded persisted tombstone: proves the storage activation
    // loads backend state, and later that a storage-less reactivation
    // resets it instead of retaining the previous activation.
    const seeded = new Map<string, unknown>([
      [
        'omo/bgj/tombstone/ses_seeded_before_setup',
        { taskID: 'ses_seeded_before_setup', epoch: 1, recordedAt: 1 },
      ],
    ]);
    (ctx as { storage?: unknown }).storage = {
      get: async (key: string) => seeded.get(key),
      set: async () => {},
      remove: async () => {},
      scan: async () => ({
        entries: [...seeded.entries()].map(([key, value]) => ({
          key,
          value,
        })),
      }),
    };
    const cleanup = await createV2Setup()(ctx);

    try {
      await flushLoggerForTesting();
      const logText = readPluginLog();
      expect(logText).toContain(
        '[v2] background-job persistence enabled via ctx.storage',
      );
      const persistence = await import('../utils/background-job-persistence');
      expect(
        persistence
          .persistedBackgroundJobState()
          .tombstones.has('ses_seeded_before_setup'),
      ).toBe(true);

      // A storage-less reactivation resets to the documented
      // process-local fallback instead of retaining this activation's
      // backend/seed state.
      const { ctx: bareCtx } = makeMockV2Context(projectDir);
      await (await createV2Setup()(bareCtx))();
      expect(persistence.persistedBackgroundJobState().tombstones.size).toBe(0);
    } finally {
      // Reset the persistence singleton so later test files in this
      // process see the pure memory fallback.
      const { configureBackgroundJobPersistence } = await import(
        '../utils/background-job-persistence'
      );
      configureBackgroundJobPersistence(undefined);
      await cleanup();
    }
  }, 30_000);

  test('dispose runs the v1 dispose hook (server.instance.disposed synthesis for wake timers)', async () => {
    const { ctx } = makeMockV2Context(projectDir);
    const cleanup = await createV2Setup()(ctx);
    await cleanup();
    await flushLoggerForTesting();

    // The v1 dispose hook synthesizes `server.instance.disposed` into the
    // v1 event consumers — orchestrator-wake scheduler timers/state,
    // task-session manager. Without this wiring, host teardown would leak
    // the scheduler's unref'd wake timers.
    const logText = readPluginLog();
    expect(logText).toContain('[v2] v1 dispose hook invoked');
    expect(logText).not.toContain('[v2] v1 dispose failed');
  }, 20_000);

  test('host rejecting the model.request hook name fails setup loudly', async () => {
    // Hook-name rejection is a host contract
    // violation, not a degrade path — the error propagates out of setup
    // (no fallback log, no silent skip of the Copilot initiator header).
    const { ctx, calls } = makeMockV2Context(projectDir);
    const baseHook = ctx.session.hook.bind(ctx.session);
    const rejected: string[] = [];
    (ctx.session as { hook: unknown }).hook = async (
      name: string,
      cb: unknown,
    ) => {
      if (name === 'model.request') {
        rejected.push(name);
        throw new Error(`unknown session hook: ${name}`);
      }
      return baseHook(name as 'context', cb as never);
    };

    await expect(createV2Setup()(ctx)).rejects.toThrow(
      'unknown session hook: model.request',
    );

    // Bridges registered before the failure are intact.
    expect(rejected).toEqual(['model.request']);
    expect(calls.hooks).toContain('session:context');
    expect(calls.hooks).toContain('session:prompt');
    expect(calls.contextHookCb).toBeFunction();

    // Abort-path unwinding: every registration saved before the failure
    // is disposed — LIFO, so the most recent registration (the prompt
    // hook) is disposed before the earliest (the agent transform) — and
    // the v1 dispose hook runs before the original error is rethrown.
    expect(calls.disposed).toContain('agent:1');
    expect(calls.disposed).toContain('session.hook:context');
    expect(calls.disposed).toContain('session.hook:prompt');
    expect(calls.disposed.indexOf('session.hook:prompt')).toBeLessThan(
      calls.disposed.indexOf('agent:1'),
    );

    await flushLoggerForTesting();
    const logText = readPluginLog();
    expect(logText).not.toContain('chat.headers not bridged');
    expect(logText).toContain('[v2] v1 dispose hook invoked (abort path)');
  }, 20_000);
});
