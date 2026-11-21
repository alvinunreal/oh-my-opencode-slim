/**
 * v2 `session.generate` shaping bridge (issue #1934).
 *
 * Upstream fires auxiliary `session.generate` requests through the
 * `generate` session hook, not `context`, with the same mutable
 * system/messages/options payload built from the primary request's base
 * transcript. Coverage:
 * - registration: the bridge installs alongside `context` and is captured
 *   from setup (not a private helper call), so wiring drift fails here
 * - byte parity: the same request fed to the context callback and to the
 *   generate callback yields identical `system` bytes and `options`
 * - the transform's own agent gate still holds: an auxiliary agent
 *   (`title`) running through `generate` never receives the orchestrator
 *   prompt, only the host's collapsed system bytes
 * - messages are deliberately NOT shaped by the generate path
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createV2Setup } from './setup';
import type {
  V2Context,
  V2SessionContextEvent,
  V2SessionGenerateEvent,
} from './types';

/** Event stream that never yields (the pump parks until dispose). */
function neverIterable(): AsyncIterable<Record<string, unknown>> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<Record<string, unknown>>>(() => {}),
      return: () =>
        Promise.resolve({ value: undefined, done: true } as IteratorResult<
          Record<string, unknown>
        >),
    }),
  };
}

type ShapeCb = (event: {
  sessionID: string;
  agent: string;
  model: Record<string, unknown>;
  options?: Record<string, unknown>;
  system: Array<{ type: 'text'; text: string }>;
  messages: Array<Record<string, unknown>>;
  tools: Record<string, unknown>;
}) => Promise<void>;

/** Host-provided base system (core env block + any other entry). The v1
 * system transform appends the orchestrator prompt to `system[0]` and then
 * collapses the array. */
const HOST_SYSTEM = [
  { type: 'text' as const, text: '<env>fixture</env>' },
  { type: 'text' as const, text: 'host system rules' },
];

function makeRequest(
  agent: string,
  overrides: Record<string, unknown> = {},
): {
  sessionID: string;
  agent: string;
  model: Record<string, unknown>;
  options: Record<string, unknown>;
  system: Array<{ type: 'text'; text: string }>;
  messages: Array<Record<string, unknown>>;
  tools: Record<string, unknown>;
} {
  return {
    sessionID: 'ses_gen_shape',
    agent,
    model: {
      id: 'claude-sonnet-4.6',
      providerID: 'github-copilot',
    },
    options: {},
    system: HOST_SYSTEM.map((part) => ({ ...part })),
    messages: [
      {
        id: 'msg_1',
        role: 'user',
        content: [{ type: 'text', text: 'warm up' }],
        sessionID: 'ses_gen_shape',
        agent,
      },
    ],
    tools: {},
    ...overrides,
  };
}

describe('createV2Setup generate hook shaping', () => {
  let originalEnv: typeof process.env;
  let fixtureRoot: string;
  let projectDir: string;
  let configDir: string;
  let logDir: string;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    fixtureRoot = await mkdtemp(path.join(tmpdir(), 'omo-v2-generate-'));
    projectDir = path.join(fixtureRoot, 'project');
    configDir = path.join(fixtureRoot, 'config');
    logDir = path.join(fixtureRoot, 'logs');
    await mkdir(configDir, { recursive: true });
    // Minimal hermetic fixture (mirrors setup-compaction.test.ts): companion
    // disabled, plus orchestrator request options so the runtime-profile step
    // has bytes to apply (the parity assertion must not be vacuous).
    await Bun.write(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        companion: { enabled: false },
        agents: {
          orchestrator: {
            temperature: 0.3,
            options: { textVerbosity: 'low' },
          },
        },
      }),
    );
    process.env.OPENCODE_CONFIG_DIR = configDir;
    process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, 'xdg-config');
    process.env.XDG_DATA_HOME = path.join(fixtureRoot, 'xdg-data');
    process.env.XDG_CACHE_HOME = path.join(fixtureRoot, 'xdg-cache');
    process.env.OPENCODE_LOG_DIR = logDir;
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  function makeCtx(): {
    ctx: V2Context;
    hooks: string[];
    getContextCb: () => ShapeCb | undefined;
    getGenerateCb: () => ShapeCb | undefined;
  } {
    const hooks: string[] = [];
    let contextCb: ShapeCb | undefined;
    let generateCb: ShapeCb | undefined;
    const ctx = {
      app: { name: 'opencode', version: 'v2-generate-test' },
      options: {},
      location: {
        directory: projectDir,
        project: {
          id: 'proj_generate',
          directory: projectDir,
          canonical: projectDir,
        },
      },
      mcp: {
        transform: async (
          cb: (draft: {
            list: () => [];
            set: (...args: unknown[]) => void;
          }) => void,
        ) => {
          cb({ list: () => [], set: () => {} });
          return { dispose: () => {} };
        },
      },
      agent: {
        transform: async (cb: (draft: unknown) => void) => {
          cb({
            list: () => [],
            get: () => undefined,
            default: () => {},
            update: () => {},
            remove: () => {},
          });
          return { dispose: () => {} };
        },
        reload: async () => ({}),
        list: async () => [],
      },
      session: {
        hook: async (name: string, cb: ShapeCb) => {
          hooks.push(name);
          if (name === 'context') contextCb = cb;
          if (name === 'generate') generateCb = cb;
          return { dispose: () => {} };
        },
        switchModel: async () => {},
      },
      event: { subscribe: () => neverIterable() },
    } as unknown as V2Context;
    return {
      ctx,
      hooks,
      getContextCb: () => contextCb,
      getGenerateCb: () => generateCb,
    };
  }

  test('generate shapes system/options byte-identically to context', async () => {
    const { ctx, hooks, getContextCb, getGenerateCb } = makeCtx();
    const cleanup = await createV2Setup()(ctx);
    try {
      expect(hooks).toContain('context');
      expect(hooks).toContain('generate');
      const contextCb = getContextCb();
      const generateCb = getGenerateCb();
      expect(contextCb).toBeFunction();
      expect(generateCb).toBeFunction();
      if (!contextCb || !generateCb) {
        throw new Error('session hooks not captured');
      }

      const contextEvent = makeRequest('orchestrator');
      const generateEvent = makeRequest('orchestrator');
      await contextCb(contextEvent as unknown as V2SessionContextEvent);
      await generateCb(generateEvent as unknown as V2SessionGenerateEvent);

      // Same host system in, same shaped system out — this is the cache
      // parity the bridge exists for (issue #1934).
      expect(generateEvent.system).toEqual(contextEvent.system);
      expect(generateEvent.options).toEqual(contextEvent.options);
      // The runtime-profile step actually ran (not a vacuous parity pass).
      expect(contextEvent.options).toEqual({
        textVerbosity: 'low',
        temperature: 0.3,
      });
      // Both paths took the orchestrator branch (prompt injected, array
      // collapsed to the host core's single system message).
      expect(contextEvent.system.length).toBe(1);
      expect(contextEvent.system[0]?.text).toContain('<Workflow>');
      expect(contextEvent.system[0]?.text).not.toContain('<Agents>');
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('an auxiliary generate agent never receives the orchestrator prompt', async () => {
    const { ctx, getGenerateCb } = makeCtx();
    const cleanup = await createV2Setup()(ctx);
    try {
      const generateCb = getGenerateCb();
      expect(generateCb).toBeFunction();
      if (!generateCb) throw new Error('generate hook not captured');

      const event = makeRequest('title');
      await generateCb(event as unknown as V2SessionGenerateEvent);

      // The transform's own request-agent gate still holds through the
      // generate bridge: only the host's system entries (collapsed), no
      // orchestrator instructions.
      expect(event.system).toEqual([
        { type: 'text', text: '<env>fixture</env>\n\nhost system rules' },
      ]);
      expect(event.system[0]?.text).not.toContain('<Workflow>');
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('generate leaves messages untouched (turn-state shaping is not replayed)', async () => {
    const { ctx, getGenerateCb } = makeCtx();
    const cleanup = await createV2Setup()(ctx);
    try {
      const generateCb = getGenerateCb();
      if (!generateCb) throw new Error('generate hook not captured');

      const event = makeRequest('orchestrator');
      const before = JSON.stringify(event.messages);
      await generateCb(event as unknown as V2SessionGenerateEvent);
      expect(JSON.stringify(event.messages)).toBe(before);
    } finally {
      await cleanup();
    }
  }, 20_000);
});
