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
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, readdirSync as readDirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { BundledSkillInfo } from '../cli/custom-skills';
import { stateFilePath } from '../companion/manager';
import { MarketplaceStore } from '../marketplace/store';
import { createEventDirectoryScope } from '../utils/event-directory-scope';
import { flushLoggerForTesting } from '../utils/logger';
import { compilePermissionPolicy } from './permissions';
import { createV2Setup } from './setup';
import type { V2Context, V2PermissionRule } from './types';

type CapturedTool = {
  name: string;
  options?: { codemode?: boolean };
  execute: (input: unknown, context: unknown) => Promise<unknown>;
};

interface MockCalls {
  agentUpdates: Array<{ id: string }>;
  agentDefault: string | undefined;
  agentTransformCount: number;
  toolAdds: CapturedTool[];
  commandAdds: Array<{ name: string; definition: Record<string, unknown> }>;
  skillAdds: BundledSkillInfo[];
  mcpSets: Array<{ name: string; config: Record<string, unknown> }>;
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
  promptHookCb:
    | ((event: {
        sessionID: string;
        messageID: string;
        prompt: { text: string };
      }) => Promise<void>)
    | undefined;
  disposed: string[];
  /** Replay registered skill transforms for one simulated state rebuild. */
  rebuildSkills: () => void;
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
  skillDraftHasAdd = true,
): {
  ctx: V2Context;
  calls: MockCalls;
  events: ReturnType<typeof createEventQueue>;
} {
  const skillCallbacks = new Set<(draft: unknown) => void>();
  const calls: MockCalls = {
    agentUpdates: [],
    agentDefault: undefined,
    agentTransformCount: 0,
    toolAdds: [],
    commandAdds: [],
    skillAdds: [],
    mcpSets: [],
    hooks: [],
    toolBeforeCb: undefined,
    toolAfterCb: undefined,
    contextHookCb: undefined,
    promptHookCb: undefined,
    disposed: [],
    rebuildSkills: () => {
      for (const cb of skillCallbacks) {
        cb({
          ...(skillDraftHasAdd
            ? {
                add: (skill: BundledSkillInfo) => {
                  calls.skillAdds.push(skill);
                },
              }
            : {}),
          get: () => undefined,
          list: () => [],
          remove: () => {},
          update: () => {},
        });
      }
    },
  };
  const events = createEventQueue();
  const reg = (label: string) => ({
    dispose: () => {
      calls.disposed.push(label);
    },
  });
  // The skill domain replays registered transforms on simulated dirty-state
  // rebuilds. The registration handle removes its callback on disposal.
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
        cb({
          list: () => [],
          get: () => undefined,
          default: (id: string | undefined) => {
            calls.agentDefault = id;
          },
          update: (id: string, fn: (agent: unknown) => void) => {
            calls.agentUpdates.push({ id });
            fn({});
          },
          remove: () => {},
        });
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
    skill: {
      transform: async (cb: (draft: unknown) => void) => {
        skillCallbacks.add(cb);
        return {
          dispose: () => {
            calls.disposed.push('skill.transform');
            skillCallbacks.delete(cb);
          },
        };
      },
      list: async () => [],
      reload: async () => {},
    },
    // Runtime session methods deliberately ABSENT: the shim must degrade
    // honestly without them (no fake success shapes).
    session: {
      hook: async (
        name: 'context' | 'prompt',
        cb: (event: never) => Promise<void>,
      ) => {
        calls.hooks.push(`session:${name}`);
        if (name === 'context') {
          calls.contextHookCb = cb as unknown as MockCalls['contextHookCb'];
        } else if (name === 'prompt') {
          calls.promptHookCb = cb as unknown as MockCalls['promptHookCb'];
        }
        return reg(`session.hook:${name}`);
      },
    },
    mcp: {
      transform: async (cb: (draft: unknown) => void) => {
        cb({
          list: () => [],
          get: () => undefined,
          set: (name: string, config: Record<string, unknown>) => {
            calls.mcpSets.push({ name, config });
          },
          update: () => {},
          remove: () => {},
        });
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

  return { ctx, calls, events };
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
    fixtureRoot = await mkdtemp(path.join(tmpdir(), 'omo-v2-setup-e2e-'));
    projectDir = path.join(fixtureRoot, 'project');
    configDir = path.join(fixtureRoot, 'config');
    logDir = path.join(fixtureRoot, 'logs');
    await mkdir(path.join(projectDir, '.opencode'), { recursive: true });
    await Bun.write(
      path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
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
    expect(calls.toolAdds.map((tool) => tool.name)).toContain(
      'marketplace_inspect',
    );
    expect(calls.toolAdds.map((tool) => tool.name)).toContain(
      'marketplace_manage',
    );
    // CodeMode split (upstream Tool.snapshot): every registered tool must
    // carry `options: { codemode: false }` or it never becomes a direct
    // model-visible tool definition — it lands in the `execute` tool's
    // confined JS runtime and session catalogs yield `Unknown tool: ...`.
    for (const tool of calls.toolAdds) {
      expect(tool.options).toEqual({ codemode: false });
    }
    expect(calls.commandAdds.map((c) => c.name)).toContain('deepwork');
    expect(calls.commandAdds.map((c) => c.name)).toContain('interview');
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
    expect(calls.promptHookCb).toBeFunction();
    await calls.promptHookCb?.({
      sessionID: 'ses_baseline_unknown',
      messageID: 'msg_baseline',
      prompt: { text: 'baseline' },
    });

    await cleanup();
    expect(calls.disposed.length).toBeGreaterThan(0);
  }, 20_000);

  test('skips built-in MCP injection when the host owns the key', async () => {
    // User/host-configured namespaces own their key (issue #1290): a
    // built-in must never be injected over an existing draft entry.
    const { ctx, calls } = makeMockV2Context(projectDir);
    const setupCtx = ctx as unknown as {
      mcp: {
        transform: (callback: (draft: unknown) => void) => Promise<{
          dispose: () => void;
        }>;
      };
    };
    setupCtx.mcp.transform = async (callback) => {
      callback({
        list: () => [['gh_grep', { type: 'local', command: ['x'] }]],
        get: (name: string) =>
          name === 'gh_grep' ? { type: 'local', command: ['x'] } : undefined,
        set: (name: string, config: Record<string, unknown>) => {
          calls.mcpSets.push({ name, config });
        },
        update: () => {},
        remove: () => {},
      });
      return { dispose: () => {} };
    };
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(calls.mcpSets.map((m) => m.name)).toEqual(['context7']);
      expect(calls.mcpSets.map((m) => m.config)).toEqual([
        expect.objectContaining({ type: 'remote' }),
      ]);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('bundled skills register through a lazily replayed draft', async () => {
    // Deferred execution previously prevented setup from retaining the
    // registration's explicit cleanup handle.
    const legacyDir = path.join(configDir, '.oh-my-opencode-slim');
    await mkdir(legacyDir, { recursive: true });
    await Bun.write(path.join(legacyDir, 'skills-manifest.json'), '{ invalid');
    const { ctx, calls } = makeMockV2Context(projectDir);
    const cleanup = await createV2Setup()(ctx);

    // Nothing has reached the draft yet — the await has already settled.
    expect(calls.skillAdds).toEqual([]);

    calls.rebuildSkills();
    const firstRebuildCount = calls.skillAdds.length;
    expect(firstRebuildCount).toBeGreaterThan(0);
    calls.rebuildSkills();
    expect(calls.skillAdds).toHaveLength(firstRebuildCount * 2);
    await flushLoggerForTesting();
    expect(
      readPluginLog().match(/legacy skills manifest unreadable/g),
    ).toHaveLength(1);
    expect(calls.skillAdds.map((skill) => skill.id)).toContain('deepwork');
    for (const skill of calls.skillAdds) {
      expect(skill.path.endsWith('SKILL.md')).toBe(true);
      expect(skill.content).toBeString();
    }

    await cleanup();
    expect(calls.disposed).toContain('skill.transform');
  }, 20_000);

  test('retries a throwing legacy skill cleanup on a later rebuild', async () => {
    const legacyDir = path.join(configDir, '.oh-my-opencode-slim');
    await mkdir(legacyDir, { recursive: true });
    await Bun.write(
      path.join(legacyDir, 'skills-manifest.json'),
      JSON.stringify({ skills: {} }),
    );
    const { ctx, calls } = makeMockV2Context(projectDir);
    const cleanup = await createV2Setup()(ctx);

    try {
      // A path-filtered spy, as the marketplace cleanup tests use, so the
      // failure is induced the same way for every uid. chmod would not
      // constrain root, and replacing the module breaks this file's imports.
      const realRmSync = fs.rmSync;
      const removeSpy = spyOn(fs, 'rmSync').mockImplementation(((
        target: fs.PathLike,
        options: fs.RmOptions,
      ) => {
        if (target === legacyDir) {
          throw new Error('injected legacy cleanup failure');
        }
        return realRmSync(target, options);
      }) as typeof fs.rmSync);
      try {
        calls.rebuildSkills();
      } finally {
        removeSpy.mockRestore();
      }

      await flushLoggerForTesting();
      expect(
        readPluginLog().match(/legacy skill cleanup failed/g),
      ).toHaveLength(1);
      expect(existsSync(legacyDir)).toBe(true);

      // The guard must not latch on failure: a later rebuild retries.
      calls.rebuildSkills();
      expect(existsSync(legacyDir)).toBe(false);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('does not migrate legacy skills when the deferred draft lacks add()', async () => {
    const legacyDir = path.join(configDir, '.oh-my-opencode-slim');
    await mkdir(legacyDir, { recursive: true });
    await Bun.write(
      path.join(legacyDir, 'skills-manifest.json'),
      JSON.stringify({ skills: { deepwork: { status: 'managed' } } }),
    );
    const { ctx, calls } = makeMockV2Context(projectDir, false);
    const cleanup = await createV2Setup()(ctx);
    calls.rebuildSkills();
    await flushLoggerForTesting();

    expect(readPluginLog()).toContain('ctx.skill draft lacks add()');
    expect(
      await Bun.file(path.join(legacyDir, 'skills-manifest.json')).exists(),
    ).toBe(true);
    await cleanup();
  }, 20_000);

  test('v2 context bridge preserves live model variant into Companion state', async () => {
    await Bun.write(
      path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({
        companion: {
          enabled: true,
          binaryPath: path.join(fixtureRoot, 'missing-companion-bin'),
        },
      }),
    );

    const { ctx, calls, events } = makeMockV2Context(projectDir);
    const cleanup = await createV2Setup()(ctx);

    try {
      expect(calls.contextHookCb).toBeFunction();
      events.push({
        type: 'session.execution.started',
        data: { sessionID: 'ses_companion_variant' },
      });
      await settlePump();
      await calls.contextHookCb?.({
        sessionID: 'ses_companion_variant',
        agent: 'fixer',
        model: {
          providerID: 'openai',
          id: 'gpt-live',
          variant: 'reasoning-high',
        },
        system: [],
        tools: {},
        messages: [
          {
            info: { id: 'user-live-variant', role: 'user' },
            parts: [{ type: 'text', text: 'hello' }],
          },
        ],
      });

      const state = JSON.parse(readFileSync(stateFilePath(), 'utf8')) as {
        sessions: Array<{
          active_agent_details?: Array<{
            session_id: string;
            agent: string;
            model?: string;
            variant?: string;
          }>;
        }>;
      };
      const details = state.sessions.flatMap(
        (session) => session.active_agent_details ?? [],
      );

      expect(details).toContainEqual({
        session_id: 'ses_companion_variant',
        agent: 'fixer',
        model: 'openai/gpt-live',
        variant: 'reasoning-high',
      });
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('v2 permission raw + synthesized delivery advances Companion attention once per request', async () => {
    await Bun.write(
      path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({
        companion: {
          enabled: true,
          binaryPath: path.join(fixtureRoot, 'missing-companion-bin'),
        },
      }),
    );

    const { ctx, events } = makeMockV2Context(projectDir);
    const cleanup = await createV2Setup()(ctx);

    try {
      events.push({
        type: 'permission.asked',
        // Supported envelopes can carry an unrelated properties object while
        // the canonical request identity remains in data.
        properties: { transport: 'v2' },
        data: {
          id: 'permission-attention-1',
          sessionID: 'ses_permission_attention',
          action: 'bash',
          resources: ['*'],
        },
      });
      await settlePump();

      const readAttentionSeq = () => {
        const state = JSON.parse(readFileSync(stateFilePath(), 'utf8')) as {
          sessions: Array<{ attention_seq?: number }>;
        };
        return state.sessions[0]?.attention_seq;
      };

      // mapV2EventToV1 delivers permission.asked raw + synthesized. The raw
      // copy has unrelated properties while its ID remains in data; both must
      // still collapse to one attention generation.
      expect(readAttentionSeq()).toBe(1);

      events.push({
        type: 'permission.asked',
        data: {
          id: 'permission-attention-2',
          sessionID: 'ses_permission_attention',
          action: 'read',
          resources: ['*'],
        },
      });
      await settlePump();
      expect(readAttentionSeq()).toBe(2);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('disabled_commands interview gates both registration and execution', async () => {
    // Override the beforeEach fixture: the all-setup wiring test must load
    // its own disabled_commands through the real loadPluginConfig path.
    await Bun.write(
      path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({
        companion: { enabled: false },
        disabled_commands: ['interview'],
      }),
    );
    const { ctx, calls } = makeMockV2Context(projectDir);
    const cleanup = await createV2Setup()(ctx);

    // Registration gate: /interview absent, non-disabled commands intact
    expect(calls.commandAdds.map((c) => c.name)).not.toContain('interview');
    expect(calls.commandAdds.map((c) => c.name)).toContain('deepwork');

    // Execution gate: a trailing interview marker passes through untouched
    const trailing = {
      id: 'tail-iv-gate',
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<omos-interview-command>build an app</omos-interview-command>',
        },
      ],
    };
    expect(calls.contextHookCb).toBeFunction();
    await calls.contextHookCb?.({
      sessionID: 'ses_iv_gate',
      agent: 'oracle',
      model: {},
      system: [],
      tools: {},
      messages: [trailing],
    });
    expect(trailing.content).toEqual([
      {
        type: 'text',
        text: '<omos-interview-command>build an app</omos-interview-command>',
      },
    ]);
    // The gate short-circuits before the service; the merged handler swallows
    // bridge errors, so assert the bridge did not fail its way into a no-op.
    // flushLoggerForTesting: log() lands via an async writeChain, and the
    // error-path line is asserted right after the awaited handler.
    await flushLoggerForTesting();
    expect(readPluginLog()).not.toContain('interview context bridge failed');

    await cleanup();
    expect(calls.disposed.length).toBeGreaterThan(0);
  }, 20_000);

  test('reduced ctx (no agent.transform) skips gracefully', async () => {
    const cleanup = await createV2Setup()({} as never);
    await cleanup(); // passes when neither call throws
  }, 20_000);

  test('retired generations reject late agent transform callbacks', async () => {
    const { ctx } = makeMockV2Context(projectDir);
    let deferred: ((draft: unknown) => void) | undefined;
    const agent = ctx.agent as unknown as {
      transform: (callback: (draft: unknown) => void) => Promise<{
        dispose: () => void;
      }>;
    };
    agent.transform = async (callback) => {
      deferred = callback;
      return { dispose: () => {} };
    };
    const cleanup = await createV2Setup()(ctx);
    await cleanup();
    expect(() => deferred?.({ list: () => [] })).toThrow('retired');
  }, 20_000);

  test('agent transform replay reuses the first finalized model and native policy', async () => {
    const { ctx } = makeMockV2Context(projectDir);
    const projectedModels: Array<Record<string, unknown> | undefined> = [];
    const projectedRequests: Array<Record<string, unknown> | undefined> = [];
    const projectedPermissions: Array<Record<string, unknown>[] | undefined> =
      [];
    const nativePermissions: Array<Record<string, unknown>[]> = [];
    const updatedAgents: string[] = [];
    const agent = ctx.agent as unknown as {
      transform: (callback: (draft: unknown) => void) => Promise<{
        dispose: () => void;
      }>;
    };
    agent.transform = async (callback) => {
      for (const providerID of ['host-first', 'host-replay']) {
        const permissions = [
          {
            action: 'read',
            resource: '*',
            effect: providerID === 'host-first' ? 'allow' : 'deny',
          },
        ];
        nativePermissions.push(permissions);
        const native = {
          id: 'orchestrator',
          mode: 'primary',
          model: { providerID, id: 'model' },
          request: {
            settings: { temperature: 0.25, topP: 0.8 },
            headers: { 'x-native': 'preserve' },
            body: { hostSetting: true },
          },
          permissions,
          untouchedByPlugin: 'foreign',
        };
        const foreign = {
          id: 'foreign-agent',
          mode: 'primary',
          permissions: [],
        };
        callback({
          list: () => [{ id: 'orchestrator' }, foreign],
          get: (id: string) => (id === 'orchestrator' ? native : foreign),
          default: () => {},
          update: (
            id: string,
            project: (draft: Record<string, unknown>) => void,
          ) => {
            const draft: Record<string, unknown> = { ...native };
            project(draft);
            updatedAgents.push(id);
            if (id === 'orchestrator') {
              projectedModels.push(
                draft.model as Record<string, unknown> | undefined,
              );
              projectedRequests.push(
                draft.request as Record<string, unknown> | undefined,
              );
              projectedPermissions.push(
                draft.permissions as Record<string, unknown>[] | undefined,
              );
            }
          },
          remove: () => {},
        });
      }
      return { dispose: () => {} };
    };

    const cleanup = await createV2Setup()(ctx);
    try {
      expect(projectedModels.length).toBeGreaterThan(1);
      expect(
        projectedModels.every((model) => model?.providerID === 'host-first'),
      ).toBe(true);
      expect(nativePermissions[1]?.[0]?.effect).toBe('deny');
      expect(
        projectedPermissions.every(
          (permissions) => permissions?.at(-1)?.effect === 'allow',
        ),
      ).toBe(true);
      expect(projectedRequests).toHaveLength(projectedModels.length);
      for (const request of projectedRequests) {
        expect(request).toMatchObject({
          settings: { temperature: 0.25, topP: 0.8 },
          headers: { 'x-native': 'preserve' },
          body: { hostSetting: true },
        });
      }
      expect(updatedAgents).not.toContain('foreign-agent');
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('late malformed agent transform fails readiness without escaping callback', async () => {
    const { ctx, calls } = makeMockV2Context(projectDir);
    let deferred: ((draft: unknown) => void) | undefined;
    const agent = ctx.agent as unknown as {
      transform: (callback: (draft: unknown) => void) => Promise<{
        dispose: () => void;
      }>;
      list: () => Promise<unknown[]>;
    };
    agent.transform = async (callback) => {
      deferred = callback;
      return {
        dispose: () => calls.disposed.push('malformed-agent-transform'),
      };
    };
    agent.list = async () => {
      deferred?.({
        list: () => [{ id: 'explorer' }],
        get: () => ({ id: 'explorer', mode: 'subagent', permissions: 'nope' }),
      });
      return [];
    };

    const cleanup = await createV2Setup()(ctx);
    try {
      const prompt = calls.promptHookCb?.({
        sessionID: 'ses_malformed_agent',
        messageID: 'msg_malformed_agent',
        prompt: { text: 'prompt waits for agent readiness' },
      });
      expect(deferred).toBeFunction();
      expect(() =>
        deferred?.({
          list: () => [{ id: 'explorer' }],
          get: () => ({
            id: 'explorer',
            mode: 'subagent',
            permissions: 'nope',
          }),
        }),
      ).not.toThrow();
      const promptError = await prompt?.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(promptError).toMatchObject({
        message: 'Agent permission snapshot finalization failed',
        cause: expect.objectContaining({
          message:
            "Native agent 'explorer' exposed a malformed permissions field",
        }),
      });
    } finally {
      await cleanup();
    }
    expect(calls.disposed).toContain('malformed-agent-transform');
  }, 20_000);

  test.each([
    ['agent registration', '/approved/scratch/report.txt', 'allow'],
    ['agent registration', '/forbidden/key', 'deny'],
    ['agent registration', '/approved/scratch/private/key', 'deny'],
    ['child projection', '/approved/scratch/report.txt', 'allow'],
    ['child projection', '/forbidden/key', 'deny'],
    ['child projection', '/approved/scratch/private/key', 'deny'],
  ] as const)(
    '#1374 post-transform policy survives child replacement: %s %s %s',
    async (surface, resource, expected) => {
      await Bun.write(
        path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
        JSON.stringify({
          companion: { enabled: false },
          agents: {
            fixer: {
              permission: {
                external_directory: { '/approved/scratch/private/*': 'deny' },
              },
            },
          },
        }),
      );
      const globalRules: V2PermissionRule[] = [
        { action: 'external_directory', resource: '*', effect: 'ask' },
        {
          action: 'external_directory',
          resource: '/approved/scratch/*',
          effect: 'allow',
        },
        {
          action: 'external_directory',
          resource: '/forbidden/*',
          effect: 'deny',
        },
      ];
      const { ctx, calls, events } = makeMockV2Context(projectDir);
      const registered = new Map<string, Record<string, unknown>>();
      const childUpdates: V2PermissionRule[][] = [];
      ctx.agent.transform = async (callback) => {
        callback({
          // Only the host's build agent exists; fixer is created by the plugin.
          list: () => [{ id: 'build' }],
          get: (id: string) =>
            id === 'build' ? { id, mode: 'primary' } : undefined,
          update: (
            id: string,
            mutate: (draft: Record<string, unknown>) => void,
          ) => {
            const draft: Record<string, unknown> = {};
            mutate(draft);
            registered.set(id, draft);
          },
          default: () => {},
          remove: () => {},
        });
        return { dispose: () => {} };
      };
      ctx.session.update = async (input) => {
        if (input.sessionID === 'child-1374' && input.permissions) {
          childUpdates.push(input.permissions);
        }
        return {};
      };

      const cleanup = await createV2Setup()(ctx);
      try {
        const finalizedAgent = registered.get('fixer');
        expect(finalizedAgent).toBeDefined();
        const pluginRules = finalizedAgent?.permissions as V2PermissionRule[];
        expect(pluginRules).toBeDefined();
        // v2.0.20 ConfigAgentPlugin runs AFTER external plugin transforms.
        // Global policy is absent from the initial snapshot by design; the
        // host appends expanded global rules, then explicit per-agent rules.
        const finalizedRules: V2PermissionRule[] = [
          ...pluginRules,
          ...globalRules,
          {
            action: 'external_directory',
            resource: '/approved/scratch/private/*',
            effect: 'deny',
          },
        ];
        if (finalizedAgent) finalizedAgent.permissions = finalizedRules;
        ctx.agent.list = async () => [...registered.values()] as never;
        // Prove the host finalized policy is correct before any child update.
        expect(
          compilePermissionPolicy({
            baselineRules: finalizedRules,
            hostRules: [],
          }).decide('external_directory', resource),
        ).toBe(expected);
        if (surface === 'child projection') {
          events.push({
            type: 'session.created',
            data: {
              sessionID: 'child-1374',
              parentID: 'parent-1374',
              agent: 'fixer',
            },
          });
          await settlePump();
          await calls.promptHookCb?.({
            sessionID: 'child-1374',
            messageID: 'message-1374',
            prompt: { text: 'read the approved scratch path' },
          });
          // The child must actually be projected, not merely left alone.
          expect(childUpdates.length).toBeGreaterThan(0);
        }
        const policy = compilePermissionPolicy({
          baselineRules: finalizedRules,
          // session.update replaces the session-scoped list; its last payload
          // is evaluated after the correctly finalized agent rules.
          hostRules: childUpdates.at(-1) ?? [],
        });
        expect(policy.decide('external_directory', resource)).toBe(expected);
      } finally {
        await cleanup();
      }
    },
    20_000,
  );

  test('#1374 an agent pass that ran before the MCP snapshot is rebuilt so host config rules reach plugin agents', async () => {
    const { ctx } = makeMockV2Context(projectDir);
    const globalRules: V2PermissionRule[] = [
      {
        action: 'external_directory',
        resource: '/approved/*',
        effect: 'allow',
      },
    ];
    let pluginAgentTransform: ((draft: unknown) => void) | undefined;
    let pluginMcpTransform: ((draft: unknown) => void) | undefined;
    let agents = new Map<string, Record<string, unknown>>();
    let reloads = 0;
    // Host State semantics: every read rebuilds a fresh candidate by running
    // transforms in order; the host config transform (internal post plugin)
    // appends global rules to every agent present at that point.
    const rebuild = () => {
      const next = new Map<string, Record<string, unknown>>([
        ['build', { id: 'build', permissions: [] }],
      ]);
      const editor = {
        list: () => [...next.values()],
        get: (id: string) => next.get(id),
        update: (
          id: string,
          mutate: (agent: Record<string, unknown>) => void,
        ) => {
          const agent = next.get(id) ?? { id, permissions: [] };
          mutate(agent);
          next.set(id, agent);
        },
        default: () => {},
        remove: (id: string) => next.delete(id),
      };
      pluginAgentTransform?.(editor);
      for (const agent of editor.list()) {
        (agent.permissions as V2PermissionRule[]).push(...globalRules);
      }
      agents = next;
    };
    ctx.agent.transform = async (callback) => {
      pluginAgentTransform = callback as (draft: unknown) => void;
      return { dispose: () => {} };
    };
    ctx.agent.reload = async () => {
      reloads += 1;
      rebuild();
    };
    ctx.agent.list = async () => [...agents.values()] as never;
    (
      ctx.mcp as unknown as {
        transform: (callback: (draft: unknown) => void) => Promise<{
          dispose: () => void;
        }>;
      }
    ).transform = async (callback) => {
      pluginMcpTransform = callback;
      return { dispose: () => {} };
    };

    const cleanup = await createV2Setup()(ctx);
    try {
      // The agent pass runs before the MCP inventory is known.
      rebuild();
      expect(agents.has('explorer')).toBe(false);
      pluginMcpTransform?.({
        list: () => [],
        get: () => undefined,
        set: () => {},
        update: () => {},
        remove: () => {},
      });
      await settlePump();

      expect(reloads).toBe(1);
      const explorer = agents.get('explorer');
      expect(explorer).toBeDefined();
      expect(
        compilePermissionPolicy({
          baselineRules: explorer?.permissions as V2PermissionRule[],
          hostRules: [],
        }).decide('external_directory', '/approved/report.txt'),
      ).toBe('allow');
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('native agents without a permissions field register normally', async () => {
    const { ctx } = makeMockV2Context(projectDir);
    let deferred: ((draft: unknown) => void) | undefined;
    const agent = ctx.agent as unknown as {
      transform: (callback: (draft: unknown) => void) => Promise<{
        dispose: () => void;
      }>;
      list: () => Promise<unknown[]>;
    };
    agent.transform = async (callback) => {
      deferred = callback;
      return { dispose: () => {} };
    };
    agent.list = async () => {
      deferred?.({
        list: () => [{ id: 'build' }],
        get: () => ({ id: 'build', mode: 'primary' }),
        update: (_name: string, mutate: (agent: unknown) => void) => mutate({}),
        default: () => {},
        remove: () => {},
      });
      return [];
    };

    const cleanup = await createV2Setup()(ctx);
    await cleanup();
  }, 20_000);

  test('v2 draft registration applies display-name model and ordered policy overrides', async () => {
    await mkdir(path.join(projectDir, '.opencode'), { recursive: true });
    await Bun.write(
      path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({
        companion: { enabled: false },
        agents: {
          explorer: { displayName: 'Scout', mcps: ['context7'] },
        },
      }),
    );
    const { ctx } = makeMockV2Context(projectDir);
    const registered = new Map<string, Record<string, unknown>>();
    const visibleRules = [
      { action: 'skill', resource: '*', effect: 'allow' },
      { action: 'skill', resource: 'review-tools', effect: 'deny' },
      { action: 'context7_*', resource: '*', effect: 'deny' },
    ];
    const canonicalRules = [
      { action: 'context7_*', resource: '*', effect: 'allow' },
    ];
    const nativeAgents: Record<string, Record<string, unknown>> = {
      explorer: {
        id: 'explorer',
        mode: 'subagent',
        model: { providerID: 'canonical', id: 'canonical-model' },
        permissions: canonicalRules,
      },
      Scout: {
        id: 'Scout',
        mode: 'subagent',
        model: { providerID: 'visible', id: 'visible-model' },
        permissions: visibleRules,
      },
    };
    const agent = ctx.agent as unknown as {
      transform: (callback: (draft: unknown) => void) => Promise<{
        dispose: () => void;
      }>;
    };
    agent.transform = async (callback) => {
      callback({
        list: () => Object.keys(nativeAgents).map((id) => ({ id })),
        get: (id: string) => nativeAgents[id],
        default: () => {},
        update: (
          id: string,
          project: (draft: Record<string, unknown>) => void,
        ) => {
          const draft = { ...nativeAgents[id] };
          project(draft);
          registered.set(id, draft);
        },
        remove: () => {},
      });
      return { dispose: () => {} };
    };

    const cleanup = await createV2Setup()(ctx);
    try {
      const visible = registered.get('Scout');
      const canonical = registered.get('explorer');
      expect(visible?.model).toEqual({
        providerID: 'visible',
        id: 'visible-model',
      });
      expect(visible?.permissions).toEqual(
        expect.arrayContaining(visibleRules),
      );
      expect(canonical?.model).toEqual({
        providerID: 'canonical',
        id: 'canonical-model',
      });
      expect(canonical?.permissions).not.toEqual(
        expect.arrayContaining(visibleRules),
      );
      const visibleMcpRules = (
        (visible?.permissions ?? []) as Array<Record<string, unknown>>
      ).filter((rule) => rule.action === 'context7_*');
      const canonicalMcpRules = (
        (canonical?.permissions ?? []) as Array<Record<string, unknown>>
      ).filter((rule) => rule.action === 'context7_*');
      expect(visibleMcpRules.at(-1)?.effect).toBe('deny');
      expect(canonicalMcpRules.at(-1)?.effect).toBe('allow');
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('v2 clears inherited session models and variants from visible agent drafts', async () => {
    await mkdir(path.join(projectDir, '.opencode'), { recursive: true });
    await Bun.write(
      path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({
        companion: { enabled: false },
        agents: {
          explorer: { displayName: 'Scout', inheritModelFrom: 'session' },
        },
      }),
    );
    const { ctx } = makeMockV2Context(projectDir);
    const registered = new Map<string, Record<string, unknown>>();
    const nativeAgents: Record<string, Record<string, unknown>> = {
      explorer: {
        id: 'explorer',
        mode: 'subagent',
        model: {
          providerID: 'host',
          id: 'canonical',
          variant: 'canonical-v',
        },
        permissions: [],
      },
      Scout: {
        id: 'Scout',
        mode: 'subagent',
        model: { providerID: 'host', id: 'visible', variant: 'visible-v' },
        permissions: [],
      },
    };
    const agent = ctx.agent as unknown as {
      transform: (callback: (draft: unknown) => void) => Promise<{
        dispose: () => void;
      }>;
    };
    agent.transform = async (callback) => {
      callback({
        list: () => Object.keys(nativeAgents).map((id) => ({ id })),
        get: (id: string) => nativeAgents[id],
        default: () => {},
        update: (
          id: string,
          project: (draft: Record<string, unknown>) => void,
        ) => {
          const draft = { ...nativeAgents[id] };
          project(draft);
          registered.set(id, draft);
        },
        remove: () => {},
      });
      return { dispose: () => {} };
    };

    const cleanup = await createV2Setup()(ctx);
    try {
      for (const name of ['explorer', 'Scout']) {
        expect(registered.get(name)).not.toHaveProperty('model');
        expect(registered.get(name)).not.toHaveProperty('variant');
      }
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('v2 defaults to the visible orchestrator and keeps canonical hidden', async () => {
    await mkdir(path.join(projectDir, '.opencode'), { recursive: true });
    await Bun.write(
      path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({
        companion: { enabled: false },
        agents: { orchestrator: { displayName: 'Lead' } },
      }),
    );
    const { ctx } = makeMockV2Context(projectDir);
    const registered = new Map<string, Record<string, unknown>>();
    let defaultAgent: string | undefined;
    const nativeAgents: Record<string, Record<string, unknown>> = {
      orchestrator: {
        id: 'orchestrator',
        mode: 'primary',
        permissions: [],
      },
      Lead: {
        id: 'Lead',
        mode: 'primary',
        permissions: [],
      },
    };
    const agent = ctx.agent as unknown as {
      transform: (callback: (draft: unknown) => void) => Promise<{
        dispose: () => void;
      }>;
    };
    agent.transform = async (callback) => {
      callback({
        list: () => Object.keys(nativeAgents).map((id) => ({ id })),
        get: (id: string) => nativeAgents[id],
        default: (id: string) => {
          defaultAgent = id;
        },
        update: (
          id: string,
          project: (draft: Record<string, unknown>) => void,
        ) => {
          const draft = { ...nativeAgents[id] };
          project(draft);
          registered.set(id, draft);
        },
        remove: () => {},
      });
      return { dispose: () => {} };
    };

    const cleanup = await createV2Setup()(ctx);
    try {
      expect(defaultAgent).toBe('Lead');
      expect(registered.get('orchestrator')?.hidden).toBe(true);
      expect(registered.get('Lead')?.hidden).toBe(false);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('host-only MCP namespaces are denied in both agent and child policies', async () => {
    const { ctx, events, calls } = makeMockV2Context(projectDir);
    const setupCtx = ctx as unknown as {
      mcp: {
        transform: (callback: (draft: unknown) => void) => Promise<{
          dispose: () => void;
        }>;
      };
      agent: {
        transform: (callback: (draft: unknown) => void) => Promise<{
          dispose: () => void;
        }>;
      };
      session: {
        update: (input: {
          sessionID: string;
          permissions: Array<Record<string, unknown>>;
        }) => Promise<void>;
      };
    };
    let registeredRules: Array<Record<string, unknown>> = [];
    const childUpdates: Array<{
      sessionID: string;
      permissions: Array<Record<string, unknown>>;
    }> = [];
    setupCtx.mcp.transform = async (callback) => {
      callback({
        list: () => [['host-only', { type: 'local' }]],
        get: (name: string) =>
          name === 'host-only' ? { type: 'local' } : undefined,
        set: (name: string, config: Record<string, unknown>) => {
          calls.mcpSets.push({ name, config });
        },
        update: () => {},
        remove: () => {},
      });
      return { dispose: () => {} };
    };
    setupCtx.agent.transform = async (callback) => {
      callback({
        list: () => [],
        get: () => undefined,
        default: () => {},
        update: (
          name: string,
          project: (agent: Record<string, unknown>) => void,
        ) => {
          const agent: Record<string, unknown> = {};
          project(agent);
          if (name === 'explorer') {
            registeredRules = agent.permissions as Array<
              Record<string, unknown>
            >;
          }
        },
        remove: () => {},
      });
      return { dispose: () => {} };
    };
    setupCtx.session.update = async (input) => {
      childUpdates.push(input);
    };

    const cleanup = await createV2Setup()(ctx);
    try {
      events.push({
        type: 'session.created',
        data: {
          sessionID: 'ses_host_mcp_child',
          parentID: 'ses_parent',
          agent: 'explorer',
        },
      });
      const deadline = Date.now() + 2_000;
      while (childUpdates.length === 0 && Date.now() < deadline) {
        await Bun.sleep(10);
      }

      expect(registeredRules).toContainEqual(
        expect.objectContaining({ action: 'host-only_*', effect: 'deny' }),
      );
      expect(childUpdates).toHaveLength(1);
      expect(childUpdates[0]?.permissions).toEqual(registeredRules);
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('marketplace agent projection and child session receive the same narrowed native policy', async () => {
    const store = new MarketplaceStore({
      pluginVersion: '2.2.25',
    });
    store.install({
      manifest: {
        schemaVersion: 2,
        id: 'team/v2-marketplace',
        version: '1.0.0',
        displayName: 'V2 marketplace agent',
        description: 'Marketplace child policy fixture',
        agentName: 'v2-marketplace-agent',
        prompt: 'Use only the package-authorized capabilities.',
        skills: [],
        mcps: ['package-mcp'],
        tools: ['read'],
        author: { name: 'Test' },
        tags: [],
        license: 'MIT',
        compatibility: { plugin: '>=2.0.0' },
        model: {
          source: 'explicit',
          candidates: ['provider/package', 'provider/fallback'],
        },
        routing: {
          description: 'Marketplace test lane',
          when: 'Testing marketplace routing.',
          keywords: ['marketplace'],
        },
      } as never,
    });
    await Bun.write(
      path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({
        companion: { enabled: false },
        preset: 'marketplace-test',
        presets: {
          'marketplace-test': {
            marketplace: { agents: ['team/v2-marketplace'] },
          },
        },
      }),
    );

    const { ctx, calls, events } = makeMockV2Context(projectDir);
    const setupCtx = ctx as unknown as {
      mcp: {
        transform: (callback: (draft: unknown) => void) => Promise<{
          dispose: () => void;
        }>;
      };
      agent: {
        transform: (callback: (draft: unknown) => void) => Promise<{
          dispose: () => void;
        }>;
      };
      session: {
        update: (input: {
          sessionID: string;
          permissions: Array<Record<string, unknown>>;
        }) => Promise<void>;
      };
    };
    const childUpdates: Array<{
      sessionID: string;
      permissions: Array<Record<string, unknown>>;
    }> = [];
    let packageAgent: Record<string, unknown> | undefined;
    setupCtx.mcp.transform = async (callback) => {
      callback({
        list: () => [
          ['package-mcp', { type: 'local' }],
          ['host-only-mcp', { type: 'local' }],
        ],
        get: (name: string) =>
          name === 'package-mcp' || name === 'host-only-mcp'
            ? { type: 'local' }
            : undefined,
        set: (name: string, config: Record<string, unknown>) => {
          calls.mcpSets.push({ name, config });
        },
        update: () => {},
        remove: () => {},
      });
      return { dispose: () => {} };
    };
    setupCtx.agent.transform = async (callback) => {
      callback({
        list: () => [],
        get: () => undefined,
        default: () => {},
        update: (
          name: string,
          project: (agent: Record<string, unknown>) => void,
        ) => {
          const agent: Record<string, unknown> = {};
          project(agent);
          if (name === 'v2-marketplace-agent') packageAgent = agent;
        },
        remove: () => {},
      });
      return { dispose: () => {} };
    };
    setupCtx.session.update = async (input) => {
      childUpdates.push(input);
    };

    const cleanup = await createV2Setup()(ctx);
    try {
      expect(packageAgent).toBeDefined();
      expect(packageAgent?.model).toMatchObject({
        providerID: 'provider',
        id: 'package',
      });
      const packageRules = packageAgent?.permissions as Array<
        Record<string, unknown>
      >;
      expect(packageRules).toContainEqual(
        expect.objectContaining({ action: 'read', effect: 'allow' }),
      );
      expect(packageRules).toContainEqual(
        expect.objectContaining({
          action: 'skill',
          resource: '*',
          effect: 'deny',
        }),
      );
      expect(packageRules).toContainEqual(
        expect.objectContaining({ action: 'package-mcp_*', effect: 'allow' }),
      );
      expect(packageRules).toContainEqual(
        expect.objectContaining({ action: '*', resource: '*', effect: 'deny' }),
      );
      expect(
        packageRules.some(
          (rule) => rule.action === 'bash' && rule.effect === 'allow',
        ),
      ).toBe(false);
      expect(
        packageRules.some(
          (rule) =>
            rule.action === 'host-only-mcp_*' && rule.effect === 'allow',
        ),
      ).toBe(false);

      events.push({
        type: 'session.created',
        data: {
          sessionID: 'ses_marketplace_child',
          parentID: 'ses_marketplace_parent',
          agent: 'v2-marketplace-agent',
        },
      });
      const deadline = Date.now() + 2_000;
      while (childUpdates.length === 0 && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(childUpdates).toHaveLength(1);
      expect(childUpdates[0]?.permissions).toEqual(packageRules);
      expect(childUpdates[0]?.permissions).toContainEqual(
        expect.objectContaining({ action: '*', resource: '*', effect: 'deny' }),
      );
      // With marketplace policy active and no session.get, an unobserved
      // session may be a marketplace root and must fail closed.
      await expect(
        calls.promptHookCb?.({
          sessionID: 'ses_marketplace_unknown',
          messageID: 'msg_unknown',
          prompt: { text: 'unknown marketplace session' },
        }),
      ).rejects.toThrow(/identity is unknown; prompt blocked/i);

      // Once a session event establishes that this is a child, missing agent
      // identity is a marketplace policy barrier and must still block prompt.
      events.push({
        type: 'session.created',
        data: {
          sessionID: 'ses_marketplace_unclassified_child',
          parentID: 'ses_marketplace_parent',
        },
      });
      const childEventDeadline = Date.now() + 2_000;
      while (events.pulled() < 2 && Date.now() < childEventDeadline) {
        await Bun.sleep(10);
      }
      await Bun.sleep(10);
      await expect(
        calls.promptHookCb?.({
          sessionID: 'ses_marketplace_unclassified_child',
          messageID: 'msg_unclassified_child',
          prompt: { text: 'unclassified child' },
        }),
      ).rejects.toThrow(/identity is unknown; prompt blocked/i);

      // #1374: the child projects the host-finalized agent, whose global
      // rules follow plugin registration. Ceilings still cap those globals.
      ctx.agent.list = async () =>
        [
          {
            id: 'v2-marketplace-agent',
            permissions: [
              ...packageRules,
              { action: 'bash', resource: '*', effect: 'allow' },
              { action: 'read', resource: '/global/*', effect: 'deny' },
            ],
          },
        ] as never;
      events.push({
        type: 'session.created',
        data: {
          sessionID: 'ses_marketplace_global_child',
          parentID: 'ses_marketplace_parent',
          agent: 'v2-marketplace-agent',
        },
      });
      const globalDeadline = Date.now() + 2_000;
      while (childUpdates.length < 2 && Date.now() < globalDeadline) {
        await Bun.sleep(10);
      }
      expect(childUpdates[1]?.sessionID).toBe('ses_marketplace_global_child');
      const childPolicy = compilePermissionPolicy({
        baselineRules: packageRules as V2PermissionRule[],
        hostRules: childUpdates[1]?.permissions as V2PermissionRule[],
      });
      expect(childPolicy.decide('bash', 'ls')).toBe('deny');
      expect(childPolicy.decide('read', '/global/secret')).toBe('deny');
      expect(childPolicy.decide('read', 'src/index.ts')).toBe('allow');
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('marketplace activation fails and unwinds when child session.update is unavailable', async () => {
    const store = new MarketplaceStore({ pluginVersion: '2.2.25' });
    store.install({
      manifest: {
        schemaVersion: 2,
        id: 'team/no-child-update',
        version: '1.0.0',
        displayName: 'No child update',
        description: 'Requires child policy enforcement',
        agentName: 'no-child-update-agent',
        prompt: 'Use only admitted capabilities.',
        skills: [],
        mcps: [],
        tools: ['read'],
        author: { name: 'Test' },
        tags: [],
        license: 'MIT',
        compatibility: { plugin: '>=2.0.0' },
        model: { source: 'explicit', candidates: ['provider/package'] },
        routing: {
          description: 'Marketplace test lane',
          when: 'Testing host capability failure.',
          keywords: ['marketplace'],
        },
      } as never,
    });
    await Bun.write(
      path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({
        companion: { enabled: false },
        preset: 'marketplace-test',
        presets: {
          'marketplace-test': {
            marketplace: { agents: ['team/no-child-update'] },
          },
        },
      }),
    );
    const { ctx, calls } = makeMockV2Context(projectDir);
    const setupCtx = ctx as unknown as {
      mcp: {
        transform: (callback: (draft: unknown) => void) => Promise<{
          dispose: () => void;
        }>;
      };
      agent: {
        transform: (callback: (draft: unknown) => void) => Promise<{
          dispose: () => void;
        }>;
      };
    };
    setupCtx.mcp.transform = async (callback) => {
      callback({
        list: () => [],
        get: () => undefined,
        set: () => {},
        update: () => {},
        remove: () => {},
      });
      return {
        dispose: () => calls.disposed.push('marketplace-mcp-transform'),
      };
    };
    setupCtx.agent.transform = async (callback) => {
      callback({
        list: () => [],
        get: () => undefined,
        default: () => {},
        update: () => {},
        remove: () => {},
      });
      return {
        dispose: () => calls.disposed.push('marketplace-agent-transform'),
      };
    };

    await expect(createV2Setup()(ctx)).rejects.toThrow(
      'Marketplace agents require ctx.session.update',
    );
    expect(calls.disposed).toContain('marketplace-agent-transform');
    expect(calls.disposed).toContain('marketplace-mcp-transform');
  }, 20_000);

  test('batch-deferred MCP and agent transforms finalize before managed prompts', async () => {
    const { ctx, calls, events } = makeMockV2Context(projectDir);
    const mcp = ctx.mcp as unknown as {
      transform: (callback: (draft: unknown) => void) => Promise<{
        dispose: () => void;
      }>;
    };
    const agent = ctx.agent as unknown as {
      transform: (callback: (draft: unknown) => void) => Promise<{
        dispose: () => void;
      }>;
      list: () => Promise<unknown[]>;
    };
    let deferredMcpTransform: ((draft: unknown) => void) | undefined;
    let deferredAgentTransform: ((draft: unknown) => void) | undefined;
    const childUpdates: Array<Record<string, unknown>> = [];
    mcp.transform = async (callback) => {
      deferredMcpTransform = callback;
      return { dispose: () => calls.disposed.push('mcp.transform') };
    };
    agent.transform = async (callback) => {
      deferredAgentTransform = callback;
      return { dispose: () => calls.disposed.push('agent.transform') };
    };
    agent.list = async () => {
      throw new Error('setup must not materialize the agent registry');
    };
    (
      ctx.session as unknown as {
        update: (input: Record<string, unknown>) => Promise<void>;
      }
    ).update = async (input) => {
      childUpdates.push(input);
    };

    const cleanup = await createV2Setup()(ctx);
    try {
      expect(deferredMcpTransform).toBeFunction();
      expect(deferredAgentTransform).toBeFunction();
      expect(calls.hooks).toContain('session:prompt');
      const earlyPrompt = calls.promptHookCb?.({
        sessionID: 'ses_deferred_mcp_child',
        messageID: 'msg_early',
        prompt: { text: 'early child prompt' },
      });
      events.push({
        type: 'session.created',
        data: {
          sessionID: 'ses_deferred_mcp_child',
          parentID: 'ses_parent',
          agent: 'explorer',
        },
      });
      // Let the event pump cache the child while its initial plugin roster is
      // still empty; finalization must reclassify it rather than lose it.
      await Bun.sleep(25);

      const agentDraft = {
        list: () => [],
        get: () => undefined,
        default: () => {},
        update: (
          name: string,
          project: (draft: Record<string, unknown>) => void,
        ) => {
          const draft: Record<string, unknown> = {};
          project(draft);
          if (name === 'explorer') {
            calls.agentUpdates.push({ id: name });
            (calls as unknown as { explorerRules?: unknown }).explorerRules =
              draft.permissions;
          }
        },
        remove: () => {},
      };
      expect(() => deferredAgentTransform?.(agentDraft)).not.toThrow();
      expect(() =>
        deferredMcpTransform?.({
          list: () => [['host-only', { type: 'local' }]],
          get: () => ({ type: 'local' }),
          set: (name: string, config: Record<string, unknown>) => {
            calls.mcpSets.push({ name, config });
          },
          update: () => {},
          remove: () => {},
        }),
      ).not.toThrow();
      expect(
        (calls as unknown as { explorerRules?: Array<Record<string, unknown>> })
          .explorerRules,
      ).toContainEqual(
        expect.objectContaining({ action: 'host-only_*', effect: 'deny' }),
      );
      await flushLoggerForTesting();
      expect(readPluginLog()).toContain('[v2] agents registered {"count":6}');
      await expect(earlyPrompt).resolves.toBeUndefined();
      await calls.promptHookCb?.({
        sessionID: 'ses_deferred_mcp_child',
        messageID: 'msg_deferred_child',
        prompt: { text: 'managed child prompt after flush' },
      });
      await calls.promptHookCb?.({
        sessionID: 'ses_deferred_mcp',
        messageID: 'msg_deferred_mcp',
        prompt: { text: 'ordinary prompt after flush' },
      });
      const deadline = Date.now() + 2_000;
      while (childUpdates.length === 0 && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(childUpdates).toHaveLength(1);
      expect(childUpdates[0]?.permissions).toContainEqual(
        expect.objectContaining({ action: 'host-only_*', effect: 'deny' }),
      );
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('MCP rebuild does not re-finalize a previously consumed agent draft', async () => {
    const { ctx, calls } = makeMockV2Context(projectDir);
    const setupCtx = ctx as unknown as {
      agent: {
        transform: (callback: (draft: unknown) => void) => Promise<{
          dispose: () => void;
        }>;
      };
      mcp: {
        transform: (callback: (draft: unknown) => void) => Promise<{
          dispose: () => void;
        }>;
      };
    };
    const agentState = new Map<string, Record<string, unknown>>();
    const agentUpdates: string[] = [];
    let defaultAgent: string | undefined;
    const agentDraft = {
      list: () => [],
      get: (name: string) => agentState.get(name),
      default: (name: string | undefined) => {
        defaultAgent = name;
      },
      update: (
        name: string,
        project: (draft: Record<string, unknown>) => void,
      ) => {
        const current = agentState.get(name) ?? {};
        project(current);
        agentState.set(name, current);
        agentUpdates.push(name);
      },
      remove: () => {},
    };
    let mcpTransform: ((draft: unknown) => void) | undefined;
    const makeMcpDraft = () => ({
      list: () => [],
      get: () => undefined,
      set: (name: string, config: Record<string, unknown>) => {
        calls.mcpSets.push({ name, config });
      },
      update: () => {},
      remove: () => {},
    });
    setupCtx.agent.transform = async (callback) => {
      callback(agentDraft);
      return { dispose: () => calls.disposed.push('persistent-agent') };
    };
    setupCtx.mcp.transform = async (callback) => {
      mcpTransform = callback;
      callback(makeMcpDraft());
      return { dispose: () => calls.disposed.push('replayable-mcp') };
    };

    const cleanup = await createV2Setup()(ctx);
    try {
      const explorer = agentState.get('explorer');
      if (!explorer) throw new Error('Explorer agent was not finalized');
      const updatesAfterFinalize = agentUpdates.length;
      const downstreamPermissions = [
        { action: 'read', resource: 'downstream-only', effect: 'allow' },
      ];
      Object.assign(explorer, {
        model: { providerID: 'downstream', id: 'kept-model' },
        permissions: downstreamPermissions,
      });
      defaultAgent = 'downstream-default';

      if (!mcpTransform) throw new Error('MCP transform was not captured');
      for (let replay = 0; replay < 2; replay += 1) {
        mcpTransform(makeMcpDraft());
        expect(explorer).toMatchObject({
          model: { providerID: 'downstream', id: 'kept-model' },
          permissions: downstreamPermissions,
        });
        expect(defaultAgent).toBe('downstream-default');
        expect(agentUpdates).toHaveLength(updatesAfterFinalize);
      }
    } finally {
      await cleanup();
    }
  }, 20_000);

  test.each(['agent-first', 'mcp-first'] as const)(
    'deferred %s callback keeps an unclassified child behind the live marketplace barrier',
    async (callbackOrder) => {
      const store = new MarketplaceStore({ pluginVersion: '2.2.25' });
      store.install({
        manifest: {
          schemaVersion: 2,
          id: 'team/deferred-barrier',
          version: '1.0.0',
          displayName: 'Deferred barrier agent',
          description: 'Deferred marketplace permission fixture',
          agentName: 'deferred-barrier-agent',
          prompt: 'Use only package-authorized capabilities.',
          skills: [],
          mcps: [],
          tools: ['read'],
          author: { name: 'Test' },
          tags: [],
          license: 'MIT',
          compatibility: { plugin: '>=2.0.0' },
          model: { source: 'explicit', candidates: ['provider/package'] },
          routing: {
            description: 'Deferred marketplace lane',
            when: 'Testing deferred marketplace readiness.',
            keywords: ['marketplace'],
          },
        } as never,
      });
      await Bun.write(
        path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
        JSON.stringify({
          companion: { enabled: false },
          preset: 'deferred-marketplace-test',
          presets: {
            'deferred-marketplace-test': {
              marketplace: { agents: ['team/deferred-barrier'] },
            },
          },
        }),
      );

      const { ctx, calls, events } = makeMockV2Context(projectDir);
      const setupCtx = ctx as unknown as {
        mcp: {
          transform: (callback: (draft: unknown) => void) => Promise<{
            dispose: () => void;
          }>;
        };
        agent: {
          transform: (callback: (draft: unknown) => void) => Promise<{
            dispose: () => void;
          }>;
        };
        session: {
          update: (input: Record<string, unknown>) => Promise<void>;
        };
      };
      let deferredMcpTransform: ((draft: unknown) => void) | undefined;
      let deferredAgentTransform: ((draft: unknown) => void) | undefined;
      setupCtx.session.update = async () => {};
      setupCtx.mcp.transform = async (callback) => {
        deferredMcpTransform = callback;
        return { dispose: () => calls.disposed.push('deferred-mcp') };
      };
      setupCtx.agent.transform = async (callback) => {
        deferredAgentTransform = callback;
        return { dispose: () => calls.disposed.push('deferred-agent') };
      };

      const cleanup = await createV2Setup()(ctx);
      try {
        events.push({
          type: 'session.created',
          data: {
            sessionID: 'ses_deferred_marketplace_unclassified',
            parentID: 'ses_parent',
            agent: 'unclassified-host-agent',
          },
        });
        await Bun.sleep(25);

        const agentDraft = {
          list: () => [],
          get: () => undefined,
          default: () => {},
          update: (
            _name: string,
            project: (agent: Record<string, unknown>) => void,
          ) => project({}),
          remove: () => {},
        };
        const mcpDraft = {
          list: () => [],
          get: () => undefined,
          set: () => {},
          update: () => {},
          remove: () => {},
        };
        if (!deferredAgentTransform || !deferredMcpTransform) {
          throw new Error('deferred transforms were not captured');
        }
        if (callbackOrder === 'agent-first') {
          deferredAgentTransform(agentDraft);
          deferredMcpTransform(mcpDraft);
        } else {
          deferredMcpTransform(mcpDraft);
          deferredAgentTransform(agentDraft);
        }

        await expect(
          calls.promptHookCb?.({
            sessionID: 'ses_deferred_marketplace_unclassified',
            messageID: 'msg_deferred_marketplace_unclassified',
            prompt: { text: 'This child has no enforceable agent policy.' },
          }),
        ).rejects.toThrow('child session identity is unknown');
      } finally {
        await cleanup();
      }
    },
  );

  test('missing MCP draft callback keeps managed prompts behind readiness', async () => {
    const { ctx, calls } = makeMockV2Context(projectDir);
    const mcp = ctx.mcp as unknown as {
      transform: (callback: (draft: unknown) => void) => Promise<{
        dispose: () => void;
      }>;
    };
    mcp.transform = async () => ({
      dispose: () => calls.disposed.push('mcp.transform'),
    });

    const cleanup = await createV2Setup()(ctx);
    try {
      await expect(
        calls.promptHookCb?.({
          sessionID: 'ses_missing_mcp_draft',
          messageID: 'msg_missing_mcp_draft',
          prompt: { text: 'Do not admit without finalized MCP scope.' },
        }),
      ).rejects.toThrow('Agent permission snapshot readiness timed out');
    } finally {
      await cleanup();
    }
    expect(calls.disposed).toContain('mcp.transform');
  }, 20_000);

  test('missing MCP transform degrades gracefully (v1 host embedded v2 core)', async () => {
    const { ctx } = makeMockV2Context(projectDir);
    const mcp = ctx.mcp as unknown as { transform?: unknown };
    mcp.transform = undefined;

    // Should succeed with degraded MCP snapshot instead of failing
    const cleanup = await createV2Setup()(ctx);
    await flushLoggerForTesting();
    const logText = readPluginLog();
    expect(logText).toContain(
      '[v2] ctx.mcp.transform unavailable; skipping MCP snapshot (v1 host embedded v2 core)',
    );
    expect(logText).toContain('[v2] agents registered');

    await cleanup();
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

      // (2) An explicit sessionID the board cannot resolve is refused.
      // The before-hook throws before write-back, so the original
      // sessionID stays and the host does not spawn a replacement.
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
      await expect(resumeHook(resumeEvent)).rejects.toThrow(
        /could not be verified from host history/,
      );
      expect(resumeEvent.input.sessionID).toBe('resume_me');

      const emptyEvent = {
        tool: 'subagent',
        sessionID: 'ses_parent',
        agent: 'orchestrator',
        messageID: 'msg_1',
        id: 'call_empty',
        input: {
          agent: 'fixer',
          description: 'e2e empty id',
          prompt: 'More work',
          background: true,
          sessionID: '',
        },
      };
      await expect(beforeHook(emptyEvent)).rejects.toThrow(/empty sessionID/);
      expect(emptyEvent.input.sessionID).toBe('');

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

  test('moved child completion reaches its owning task board without foreign permission updates', async () => {
    const { ctx, calls, events } = makeMockV2Context(projectDir);
    const worktreeDir = path.join(projectDir, '.slim', 'worktrees', 'child');
    const worktreeScope = createEventDirectoryScope(worktreeDir);
    const childID = 'ses_moved_child';
    const permissionUpdates: unknown[] = [];
    let completedAt: number | undefined;
    const session = ctx.session as unknown as Record<string, unknown>;
    session.update = async (input: unknown) => {
      permissionUpdates.push(input);
    };
    session.get = async ({ sessionID }: { sessionID: string }) => ({
      id: sessionID,
      agent: sessionID === childID ? 'fixer' : 'orchestrator',
      ...(sessionID === childID ? { parentID: 'ses_parent' } : {}),
      ...(completedAt ? { outcome: 'succeeded' } : {}),
      time: { created: 1, ...(completedAt ? { idle: completedAt } : {}) },
    });
    session.context = async () =>
      completedAt
        ? [
            {
              id: 'msg_moved_result',
              type: 'assistant',
              time: { created: completedAt, completed: completedAt },
              finish: 'stop',
              content: [{ type: 'text', text: 'Moved child result' }],
            },
            {
              id: 'msg_moved_idle',
              type: 'idle',
              time: { created: completedAt },
              outcome: 'succeeded',
            },
          ]
        : [];
    const cleanup = await createV2Setup()(ctx);
    try {
      const launch = {
        tool: 'subagent',
        sessionID: 'ses_parent',
        agent: 'orchestrator',
        messageID: 'msg_launch',
        id: 'call_moved_child',
        input: {
          agent: 'fixer',
          description: 'moved child',
          prompt: 'Work in a worktree',
          background: true,
        },
      };
      await calls.toolBeforeCb?.(launch);
      await calls.toolAfterCb?.({
        ...launch,
        status: 'completed',
        result: {
          content: `The subagent is working in the background (sessionID: ${childID}).`,
        },
      });

      // The child now runs in another live location. Its task record still
      // belongs to this parent, not to the worktree's plugin instance.
      const foreignEvent = (type: string, sessionID = childID) => ({
        type,
        created: Date.now(),
        location: { directory: worktreeDir },
        data: { sessionID },
      });
      const updatesBeforeCompletion = permissionUpdates.length;
      events.push(foreignEvent('session.execution.started'));
      events.push({
        ...foreignEvent('session.created', 'ses_unrelated'),
        data: {
          sessionID: 'ses_unrelated',
          parentID: 'ses_foreign_parent',
          agent: 'fixer',
        },
      });
      await settlePump();
      completedAt = Date.now();
      events.push(foreignEvent('session.execution.succeeded'));
      events.push(foreignEvent('session.execution.succeeded', 'ses_unrelated'));
      await settlePump(100);

      const taskStatus = calls.toolAdds.find((t) => t.name === 'task_status');
      if (!taskStatus) throw new Error('task_status not registered');
      const status = (await taskStatus.execute(
        { task_id: childID },
        { sessionID: 'ses_parent' },
      )) as { content: string };
      expect(status.content).toContain('state: completed');
      expect(permissionUpdates).toHaveLength(updatesBeforeCompletion);
      const logText = readPluginLog();
      expect(logText).toContain('"taskID":"ses_moved_child"');
      expect(logText).toContain('[terminal-gate] terminal published');
      expect(logText).not.toContain('ses_unrelated');
    } finally {
      await cleanup();
      worktreeScope.release();
    }
  }, 20_000);

  test('admission uses the finalized v2 child model instead of its parent', async () => {
    await Bun.write(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        companion: { enabled: false },
        backgroundJobs: { sameProviderPolicy: { openai: 'foreground' } },
      }),
    );
    const { ctx, calls, events } = makeMockV2Context(projectDir);
    const agent = ctx.agent as unknown as {
      transform: (callback: (draft: unknown) => void) => Promise<{
        dispose: () => void;
      }>;
    };
    const hostAgents = {
      orchestrator: {
        id: 'orchestrator',
        mode: 'primary',
        model: { providerID: 'openai', id: 'parent-model' },
        permissions: [],
      },
      fixer: {
        id: 'fixer',
        mode: 'subagent',
        model: { providerID: 'anthropic', id: 'child-model' },
        permissions: [],
      },
    };
    agent.transform = async (callback) => {
      callback({
        list: () => Object.values(hostAgents),
        get: (id: string) => hostAgents[id as keyof typeof hostAgents],
        default: () => {},
        update: (
          _id: string,
          project: (draft: Record<string, unknown>) => void,
        ) => {
          project({});
        },
        remove: () => {},
      });
      return { dispose: () => {} };
    };

    const cleanup = await createV2Setup()(ctx);
    try {
      events.push({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_parent_model',
            sessionID: 'ses_admission_parent',
            providerID: 'openai',
            modelID: 'parent-model',
          },
        },
      });
      await Bun.sleep(20);

      const beforeHook = calls.toolBeforeCb;
      if (!beforeHook) throw new Error('tool:execute.before not captured');
      const childLaunch = {
        tool: 'subagent',
        sessionID: 'ses_admission_parent',
        agent: 'orchestrator',
        messageID: 'msg_admission',
        id: 'call_admission',
        input: {
          agent: 'fixer',
          description: 'verify finalized child model',
          prompt: 'Do the work',
          background: true,
        },
      };
      await beforeHook(childLaunch);

      // The policy applies to the parent's provider. If admission incorrectly
      // falls back to the parent model, this is converted to foreground.
      expect(childLaunch.input.background).toBe(true);
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

  test('disabled_hooks chat-headers skips the model.request bridge registration', async () => {
    await Bun.write(
      path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({
        companion: { enabled: false },
        disabled_hooks: ['chat-headers'],
      }),
    );
    const { ctx, calls } = makeMockV2Context(projectDir);
    const cleanup = await createV2Setup()(ctx);

    // The v1 chat.headers key is absent, so the v2 bridge skips both the
    // marker observer and the model.request registration; the rest of the
    // session hooks still register.
    expect(calls.hooks).not.toContain('session:model.request');
    expect(calls.hooks).toContain('session:context');
    expect(calls.hooks).toContain('session:prompt');

    await cleanup();

    // Control: the default config registers the model.request bridge, so
    // the absence above is the gate and not a dead registration path.
    await Bun.write(
      path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({ companion: { enabled: false } }),
    );
    const control = makeMockV2Context(projectDir);
    const controlCleanup = await createV2Setup()(control.ctx);
    expect(control.calls.hooks).toContain('session:model.request');
    await controlCleanup();
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

  test('root dispose during a paused v2 revive read does not send or import', async () => {
    const { ctx, calls } = makeMockV2Context(projectDir);
    let releaseRead: (value: Record<string, unknown>) => void = () => {};
    let started: () => void = () => {};
    const seen = new Promise<void>((resolve) => {
      started = resolve;
    });
    const prompts: unknown[] = [];
    const session = ctx.session as Record<string, unknown>;
    session.get = async (args: { sessionID?: string }) => {
      if (args.sessionID !== 'ses_child') {
        return { error: { message: 'NotFound' } };
      }
      started();
      return new Promise((resolve) => {
        releaseRead = resolve;
      });
    };
    session.context = async () => [];
    session.prompt = async (args: unknown) => {
      prompts.push(args);
      return {};
    };
    const cleanup = await createV2Setup()(ctx);
    try {
      await calls.promptHookCb?.({
        sessionID: 'ses_parent',
        messageID: 'msg_parent',
        prompt: { text: 'hello' },
      });
      await calls.contextHookCb?.({
        sessionID: 'ses_parent',
        agent: 'orchestrator',
        messages: [
          {
            info: { id: 'msg_parent', role: 'user' },
            parts: [{ type: 'text', text: 'hello' }],
          },
        ],
      });
      const revive = calls.toolAdds.find((tool) => tool.name === 'task_revive');
      expect(revive).toBeDefined();
      const pending = revive?.execute(
        { task_id: 'ses_child', prompt: 'continue' },
        { sessionID: 'ses_parent' },
      );
      await seen;
      await cleanup();
      releaseRead({
        id: 'ses_child',
        parentID: 'ses_parent',
        agent: 'fixer',
        time: { created: 9 },
      });
      await expect(pending).rejects.toThrow(
        /disposed|retired|could not|not found/i,
      );
      expect(prompts).toHaveLength(0);
    } finally {
      await cleanup();
    }
  }, 20_000);
});
