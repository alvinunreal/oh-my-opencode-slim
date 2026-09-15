/**
 * v2 compaction hook bridge (`ctx.session.hook("compaction")`, v2.0.0+).
 *
 * Coverage:
 * - tagged synthetic parts are stripped from the compaction event's
 *   message list while untagged content (user text, command markers,
 *   untagged synthetic parts) passes through unchanged
 * - read-only guarantees: `system` is never modified and `result` is
 *   never set (host-owned; open host bug — the compaction system prompt
 *   may be absent, so the bridge must not add or rewrite one)
 * - registration degrade: a host that rejects the hook name keeps the
 *   rest of setup intact with a one-time deterministic log (mirrors the
 *   prompt / model.request degrade tests in setup.e2e.test.ts)
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync as readDirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { createTaggedSyntheticPart } from '../hooks/cache-safe-injection';
import { PHASE_REMINDER_METADATA_KEY } from '../hooks/phase-reminder';
import { BACKGROUND_JOB_BOARD_METADATA_KEY } from '../hooks/task-session-manager/board-injection';
import { flushLoggerForTesting } from '../utils/logger';
import { createSessionCompactionBridge, createV2Setup } from './setup';
import type { V2Context, V2SessionCompactionEvent } from './types';

function makeCompactionEvent(
  messages: Array<{ id?: string; role: string; content: unknown[] }>,
  overrides?: Partial<V2SessionCompactionEvent>,
): V2SessionCompactionEvent {
  return {
    sessionID: 'ses_compact',
    model: {},
    system: [{ type: 'text', text: 'HOST SYSTEM' }],
    tools: {},
    messages: messages as V2SessionCompactionEvent['messages'],
    ...overrides,
  };
}

describe('createSessionCompactionBridge', () => {
  test('strips tagged synthetic parts and preserves untagged content', async () => {
    const userText = { type: 'text', text: 'real user text' };
    const commandPart = {
      type: 'text',
      text: 'DEEPWORK EXPANDED',
      synthetic: true,
    };
    const user = {
      id: 'msg_1',
      role: 'user',
      content: [
        userText,
        createTaggedSyntheticPart({
          text: 'PHASE REMINDER',
          metadataKey: PHASE_REMINDER_METADATA_KEY,
        }),
        createTaggedSyntheticPart({
          text: 'BOARD',
          metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
        }),
        commandPart,
      ],
    };
    const assistant = {
      id: 'msg_2',
      role: 'assistant',
      content: [
        { type: 'text', text: 'assistant text' },
        createTaggedSyntheticPart({
          text: 'BOARD 2',
          metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
        }),
      ],
    };
    const event = makeCompactionEvent([user, assistant]);

    await createSessionCompactionBridge()(event);

    expect(event.messages).toHaveLength(2);
    // Message envelope identity and order are preserved.
    expect(event.messages[0]).toBe(user);
    expect(event.messages[1]).toBe(assistant);
    // Untagged parts survive with their original object identity
    // (user text AND the untagged synthetic command part).
    expect(user.content).toEqual([userText, commandPart]);
    expect(user.content[0]).toBe(userText);
    expect(user.content[1]).toBe(commandPart);
    expect(assistant.content).toEqual([
      { type: 'text', text: 'assistant text' },
    ]);
  });

  test('drops messages that consist solely of tagged parts (trailing volatile board)', async () => {
    const real = {
      id: 'msg_1',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    };
    const volatile = {
      id: 'msg_2',
      role: 'user',
      content: [
        createTaggedSyntheticPart({
          text: 'volatile board',
          metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
        }),
      ],
    };
    const event = makeCompactionEvent([real, volatile]);

    await createSessionCompactionBridge()(event);

    expect(event.messages).toHaveLength(1);
    expect(event.messages[0]).toBe(real);
    expect(real.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  test('leaves system untouched and never sets result', async () => {
    const system: V2SessionCompactionEvent['system'] = [
      { type: 'text', text: 'HOST SYSTEM' },
    ];
    const message = {
      id: 'msg_1',
      role: 'user',
      content: [
        { type: 'text', text: 'user text' },
        createTaggedSyntheticPart({
          text: 'PHASE',
          metadataKey: PHASE_REMINDER_METADATA_KEY,
        }),
      ],
    };
    const event = makeCompactionEvent([message], { system });

    await createSessionCompactionBridge()(event);

    // Same reference AND same content — the bridge never rewrites the
    // compaction system prompt (host bug: it may be absent).
    expect(event.system).toBe(system);
    expect(event.system).toEqual([{ type: 'text', text: 'HOST SYSTEM' }]);
    expect(Object.hasOwn(event, 'result')).toBe(false);

    // A host-provided result is read-only for the plugin too.
    const presetResult = { summary: 'host result' };
    const message2 = {
      id: 'msg_1',
      role: 'user',
      content: [{ type: 'text', text: 'user text' }],
    };
    const event2 = makeCompactionEvent([message2], { result: presetResult });

    await createSessionCompactionBridge()(event2);

    expect(event2.result).toBe(presetResult);
  });

  test('plain messages without tags pass through unchanged', async () => {
    const user = {
      id: 'msg_1',
      role: 'user',
      content: [{ type: 'text', text: 'plain user text' }],
    };
    const marker = {
      id: 'msg_2',
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<omos-cmd-command data-name="reflect">a b</omos-cmd-command>',
        },
      ],
    };
    const assistant = {
      id: 'msg_3',
      role: 'assistant',
      content: [{ type: 'text', text: 'assistant reply' }],
    };
    const event = makeCompactionEvent([user, marker, assistant]);

    await createSessionCompactionBridge()(event);

    expect(event.messages).toHaveLength(3);
    expect(event.messages[0]).toBe(user);
    expect(event.messages[1]).toBe(marker);
    expect(event.messages[2]).toBe(assistant);
    expect(user.content).toEqual([{ type: 'text', text: 'plain user text' }]);
    expect(marker.content).toEqual([
      {
        type: 'text',
        text: '<omos-cmd-command data-name="reflect">a b</omos-cmd-command>',
      },
    ]);
    expect(assistant.content).toEqual([
      { type: 'text', text: 'assistant reply' },
    ]);
  });

  test('malformed events resolve without throwing (fail-soft)', async () => {
    const bridge = createSessionCompactionBridge();
    await expect(
      bridge(undefined as unknown as V2SessionCompactionEvent),
    ).resolves.toBeUndefined();
    await expect(
      bridge({ sessionID: 's' } as unknown as V2SessionCompactionEvent),
    ).resolves.toBeUndefined();
    await expect(
      bridge({
        sessionID: 's',
        messages: 'nope',
      } as unknown as V2SessionCompactionEvent),
    ).resolves.toBeUndefined();
  });
});

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

type CompactionCb = (event: V2SessionCompactionEvent) => Promise<void>;

describe('createV2Setup compaction hook', () => {
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

  beforeEach(async () => {
    originalEnv = { ...process.env };
    fixtureRoot = await mkdtemp('/tmp/omo-v2-compaction-');
    projectDir = path.join(fixtureRoot, 'project');
    configDir = path.join(fixtureRoot, 'config');
    logDir = path.join(fixtureRoot, 'logs');
    await Bun.write(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      // Minimal hermetic fixture (mirrors setup.e2e.test.ts): empty
      // plugin config, companion disabled.
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

  function makeCtx(options?: { rejectCompaction?: boolean }): {
    ctx: V2Context;
    hooks: string[];
    rejected: string[];
    getCompactionCb: () => CompactionCb | undefined;
    getContextCb: () => CompactionCb | undefined;
  } {
    const hooks: string[] = [];
    const rejected: string[] = [];
    let compactionCb: CompactionCb | undefined;
    let contextCb: CompactionCb | undefined;
    const ctx = {
      app: { name: 'opencode', version: 'v2-compaction-test' },
      options: {},
      location: {
        directory: projectDir,
        project: {
          id: 'proj_compact',
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
            update: () => {},
            remove: () => {},
          });
          return { dispose: () => {} };
        },
        reload: async () => ({}),
        list: async () => [],
      },
      session: {
        hook: async (name: string, cb: (event: never) => Promise<void>) => {
          if (options?.rejectCompaction && name === 'compaction') {
            rejected.push(name);
            throw new Error(`unknown session hook: ${name}`);
          }
          hooks.push(name);
          if (name === 'compaction') {
            compactionCb = cb as unknown as CompactionCb;
          }
          if (name === 'context') {
            contextCb = cb as unknown as CompactionCb;
          }
          return { dispose: () => {} };
        },
      },
      event: { subscribe: () => neverIterable() },
    } as unknown as V2Context;
    return {
      ctx,
      hooks,
      rejected,
      getCompactionCb: () => compactionCb,
      getContextCb: () => contextCb,
    };
  }

  test('registers the compaction hook; the registered callback strips tagged parts', async () => {
    const { ctx, hooks, getCompactionCb, getContextCb } = makeCtx();
    const cleanup = await createV2Setup()(ctx);

    try {
      expect(hooks).toContain('context');
      expect(hooks).toContain('compaction');
      expect(getContextCb()).toBeFunction();
      const cb = getCompactionCb();
      expect(cb).toBeFunction();
      if (!cb) throw new Error('compaction hook not captured');

      const message = {
        id: 'msg_1',
        role: 'user',
        content: [
          { type: 'text', text: 'user text' },
          createTaggedSyntheticPart({
            text: 'BOARD',
            metadataKey: BACKGROUND_JOB_BOARD_METADATA_KEY,
          }),
        ],
      };
      const event = makeCompactionEvent([message]);
      await cb(event);
      expect(message.content).toEqual([{ type: 'text', text: 'user text' }]);

      await flushLoggerForTesting();
      expect(readPluginLog()).toContain(
        '[v2] compaction bridge registered (session.compaction)',
      );
    } finally {
      await cleanup();
    }
  }, 20_000);

  test('host rejecting the compaction hook name degrades: one log, setup completes', async () => {
    const { ctx, hooks, rejected, getContextCb } = makeCtx({
      rejectCompaction: true,
    });
    const cleanup = await createV2Setup()(ctx);

    try {
      // The compaction registration was attempted exactly once and
      // rejected; every other session bridge still registered.
      expect(rejected).toEqual(['compaction']);
      expect(hooks).toContain('context');
      expect(getContextCb()).toBeFunction();

      await flushLoggerForTesting();
      const logText = readPluginLog();
      expect(logText).toContain(
        '[v2] session.hook(compaction) unavailable; compaction sees tagged content',
      );
      expect(
        logText.match(/compaction sees tagged content/g) ?? [],
      ).toHaveLength(1);
    } finally {
      await cleanup(); // must not throw despite the rejected hook
    }
  }, 20_000);
});
