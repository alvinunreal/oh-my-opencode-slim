/**
 * Generation-scope tests for the v2 one-time degradation warning latches.
 *
 * `opencode reload` (v2.0.7) destroys and recreates plugin instances
 * inside one process, so module-level latches survive the disposal. Each
 * setup() invocation must rearm them: the reloaded generation must not
 * stay silent about host-capability degradations that the previous
 * generation already reported.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { flushLoggerForTesting, initLogger } from '../utils/logger';
import {
  createSessionListShim,
  resetClientShimGenerationWarnings,
} from './client-shim';
import {
  createChatHeadersBridge,
  createPermissionRulesBridge,
  createV2Setup,
  resetV2GenerationWarnings,
} from './setup';
import type { V2Context, V2SessionModelRequestEvent } from './types';

const LIST_WARNING = '[v2][shim] session.list unavailable on this host build';
const PERMISSION_BRIDGE_DISABLED_WARNING =
  '[v2][permission-rules] child permission bridge disabled: native agent ' +
  'snapshot and ctx.session.get/update are required';

function makePrimaryRequest(): V2SessionModelRequestEvent {
  return {
    sessionID: 'ses_gen_reset',
    agent: 'orchestrator',
    model: { id: 'some-model', providerID: 'anthropic' },
    kind: 'primary',
    headers: {},
  };
}

function makeChildCreatedEvent(): Record<string, unknown> {
  return {
    type: 'session.created',
    properties: {
      sessionID: 'ses_gen_child',
      parentID: 'ses_gen_parent',
      agent: 'fixer',
    },
  };
}

describe('v2 generation warning latches', () => {
  let originalEnv: typeof process.env;
  let fixtureRoot: string;
  let logDir: string;

  const countLoggedLines = async (text: string): Promise<number> => {
    await flushLoggerForTesting();
    let joined = '';
    for (const entry of readdirSync(logDir)) {
      if (entry.startsWith('oh-my-opencode-slim.') && entry.endsWith('.log')) {
        joined += readFileSync(path.join(logDir, entry), 'utf8');
      }
    }
    return joined.split(text).length - 1;
  };

  beforeEach(async () => {
    originalEnv = { ...process.env };
    fixtureRoot = await mkdtemp('/tmp/omo-v2-gen-reset-');
    logDir = path.join(fixtureRoot, 'logs');
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: path.join(fixtureRoot, 'config'),
      XDG_CONFIG_HOME: path.join(fixtureRoot, 'xdg-config'),
      XDG_DATA_HOME: path.join(fixtureRoot, 'xdg-data'),
      XDG_CACHE_HOME: path.join(fixtureRoot, 'xdg-cache'),
      OPENCODE_LOG_DIR: logDir,
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    initLogger('gen-reset-test');
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  test('resetV2GenerationWarnings rearms the setup-side latches', async () => {
    const drift = mock(() => {});
    const headersBridge = createChatHeadersBridge(new Map(), drift);
    const unavailable = mock(() => {});
    const rulesBridge = createPermissionRulesBridge(undefined, {
      permissionForAgent: () => ({ read: { file: 'allow' } }),
      pluginAgents: new Set(['fixer']),
      onUnavailable: unavailable,
    });

    // Fire twice: the module latch must suppress the second notice.
    await headersBridge(makePrimaryRequest());
    await headersBridge(makePrimaryRequest());
    await rulesBridge.observeSessionCreated(makeChildCreatedEvent());
    await rulesBridge.observeSessionCreated(makeChildCreatedEvent());
    expect(drift).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledTimes(1);

    resetV2GenerationWarnings();

    await headersBridge(makePrimaryRequest());
    await rulesBridge.observeSessionCreated(makeChildCreatedEvent());
    expect(drift).toHaveBeenCalledTimes(2);
    expect(unavailable).toHaveBeenCalledTimes(2);
  });

  test('resetClientShimGenerationWarnings rearms the session.list notice', async () => {
    const listShim = createSessionListShim({} as never);

    await listShim({});
    await listShim({});
    expect(await countLoggedLines(LIST_WARNING)).toBe(1);

    resetClientShimGenerationWarnings();

    await listShim({});
    expect(await countLoggedLines(LIST_WARNING)).toBe(2);
  });

  test('setup() entry rearms all generation warning latches', async () => {
    // Start from a clean generation: earlier tests in this file leave
    // the latches armed.
    resetV2GenerationWarnings();

    // Arm every latch through its public trigger surface first.
    const drift = mock(() => {});
    const headersBridge = createChatHeadersBridge(new Map(), drift);
    const unavailable = mock(() => {});
    const rulesBridge = createPermissionRulesBridge(undefined, {
      permissionForAgent: () => ({ read: { file: 'allow' } }),
      pluginAgents: new Set(['fixer']),
      onUnavailable: unavailable,
    });
    const listShim = createSessionListShim({} as never);
    await headersBridge(makePrimaryRequest());
    await rulesBridge.observeSessionCreated(makeChildCreatedEvent());
    await listShim({});
    expect(drift).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(await countLoggedLines(LIST_WARNING)).toBe(1);

    const projectDir = path.join(fixtureRoot, 'project');
    await Bun.write(
      path.join(
        process.env.OPENCODE_CONFIG_DIR as string,
        'oh-my-opencode-slim.json',
      ),
      JSON.stringify({ companion: { enabled: false } }),
    );

    const cleanup = await createV2Setup()(makeSetupCtx(projectDir));
    try {
      // The new generation's bridges must warn again on the same
      // degradations instead of inheriting the old latches.
      await headersBridge(makePrimaryRequest());
      await rulesBridge.observeSessionCreated(makeChildCreatedEvent());
      await listShim({});
      expect(drift).toHaveBeenCalledTimes(2);
      // The setup fixture intentionally lacks session.get/update. Setup's
      // optional bridge probe emits the generation warning through the
      // logger, not the injected sink used by the separately-created unit
      // bridge above. The generation reset must rearm that setup-side notice.
      expect(unavailable).toHaveBeenCalledTimes(1);
      expect(await countLoggedLines(PERMISSION_BRIDGE_DISABLED_WARNING)).toBe(
        1,
      );
      expect(await countLoggedLines(LIST_WARNING)).toBe(2);
    } finally {
      await cleanup();
    }
  }, 20_000);
});

/** Compact full-capability v2 host context (all domains no-op). */
function makeSetupCtx(projectDir: string): V2Context {
  const reg = () => ({ dispose() {} });
  // Never-resolving event stream: the pump stays parked until cleanup.
  const pendingIterator = {
    next: () => new Promise(() => {}) as Promise<IteratorResult<never>>,
    return: () =>
      Promise.resolve({ value: undefined, done: true }) as Promise<
        IteratorResult<never>
      >,
  };
  return {
    app: { name: 'opencode', version: 'v2-gen-reset-test' },
    options: {},
    location: {
      directory: projectDir,
      project: {
        id: 'proj_reset',
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
        return reg();
      },
      reload: async () => ({}),
      list: async () => [],
    },
    tool: {
      transform: async (cb: (draft: unknown) => void) => {
        cb({ add: () => {} });
        return reg();
      },
      hook: async () => reg(),
    },
    command: {
      transform: async (cb: (draft: unknown) => void) => {
        cb({ add: () => {} });
        return reg();
      },
      list: async () => [],
    },
    session: {
      hook: async () => reg(),
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
        return reg();
      },
      reload: async () => {},
    },
    event: {
      subscribe: () => ({ [Symbol.asyncIterator]: () => pendingIterator }),
    },
  } as unknown as V2Context;
}
