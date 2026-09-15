/**
 * v2 per-session permission rules bridge (`ctx.permission.rules`, shipped
 * in v2.0.0 via #48351; verified against v2.0.3).
 *
 * The bridge installs exact-match permission rules derived from the child
 * agent's task-policy (the same plugin permission map that feeds the
 * static `adaptPermissions` agent registration) into each plugin-managed
 * child session when its `session.created` event arrives. Emitted rules
 * NEVER contain wildcard characters — upstream action/resource matching
 * semantics are in flux (PRs #48194/#46495/#46871), so only exact
 * `action`/`resource` strings are ever emitted.
 *
 * Coverage:
 * - (a) rules are applied when a plugin-managed child session is created
 * - (b) hosts without `permission.rules` no-op with a ONE-TIME
 *   deterministic warning (the commit-2bf290ad degradation pattern)
 * - (c) duplicate session.created delivery for the same sessionID is
 *   idempotent (applied exactly once per child)
 * - (d) emitted rules contain no wildcard characters (`*`, `?`)
 * - (e) failures are logged, never thrown into the event pump
 * - gates: root sessions (no parentID) and foreign agents are never
 *   touched (ctx.permission.rules REPLACES the session-scoped list)
 * - wiring: the createV2Setup event pump dispatches raw session.created
 *   events into the bridge (full-setup test, fixture pattern from
 *   setup-compaction.test.ts)
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import * as path from 'node:path';
import {
  __resetPermissionRulesWarningForTesting,
  createPermissionRulesBridge,
  createV2Setup,
  deriveExactPermissionRules,
} from './setup';
import type { V2Context, V2PermissionRule } from './types';

/** Task-policy fixture: nested exact patterns alongside entries that can
 * ONLY be expressed with wildcards (the '*' catch-all key, whole-tool
 * string effects, wildcard resource patterns). Only the exact entries
 * may survive derivation. */
const TASK_POLICY = {
  '*': 'deny',
  edit: 'deny',
  bash: {
    'git push': 'ask',
    'rm -rf *': 'deny',
    '*': 'ask',
  },
  task: { explorer: 'allow' },
  webfetch: { 'https://example.com/private': 'deny' },
  skill: { codemap: 'allow' },
};

/** deriveExactPermissionRules(TASK_POLICY) — insertion order, with the
 * v1→v2 action mapping (bash → execute+bash, task → subagent). */
const EXACT_RULES: V2PermissionRule[] = [
  { action: 'execute', resource: 'git push', effect: 'ask' },
  { action: 'bash', resource: 'git push', effect: 'ask' },
  { action: 'subagent', resource: 'explorer', effect: 'allow' },
  {
    action: 'webfetch',
    resource: 'https://example.com/private',
    effect: 'deny',
  },
  { action: 'skill', resource: 'codemap', effect: 'allow' },
];

type RulesCall = { sessionID: string; permissions: V2PermissionRule[] };

function makeChildCreatedEvent(
  payload: Record<string, unknown>,
  payloadKey: 'data' | 'properties' = 'data',
): Record<string, unknown> {
  return {
    type: 'session.created',
    [payloadKey]: {
      sessionID: 'ses_child_1',
      parentID: 'ses_parent',
      agent: 'probe',
      ...payload,
    },
  };
}

function makeBridge(options?: {
  permission?: V2Context['permission'];
  policy?: unknown;
  pluginAgents?: ReadonlySet<string>;
  onUnavailable?: () => void;
}): ReturnType<typeof createPermissionRulesBridge> {
  return createPermissionRulesBridge(options?.permission, {
    permissionForAgent: (agent) =>
      agent === 'probe' ? (options?.policy ?? TASK_POLICY) : undefined,
    pluginAgents: options?.pluginAgents ?? new Set(['probe']),
    ...(options?.onUnavailable ? { onUnavailable: options.onUnavailable } : {}),
  });
}

describe('deriveExactPermissionRules', () => {
  test('derives only the exact-match entries, with v1→v2 action mapping', () => {
    expect(deriveExactPermissionRules(TASK_POLICY)).toEqual(EXACT_RULES);
  });

  test('whole-tool string effects and the string shorthand are skipped', () => {
    // A whole-tool effect (edit: 'deny') has no exact resource to match,
    // and the string shorthand applies to every action — both would
    // require a wildcard, so neither may be emitted.
    expect(deriveExactPermissionRules('ask')).toEqual([]);
    expect(deriveExactPermissionRules({ edit: 'deny', read: 'allow' })).toEqual(
      [],
    );
  });

  test('question-mark wildcards are rejected like asterisks', () => {
    expect(
      deriveExactPermissionRules({ bash: { 'git push?': 'ask' } }),
    ).toEqual([]);
  });

  test('invalid shapes and invalid effects yield no rules', () => {
    expect(deriveExactPermissionRules(undefined)).toEqual([]);
    expect(deriveExactPermissionRules(null)).toEqual([]);
    expect(deriveExactPermissionRules(['edit'])).toEqual([]);
    expect(
      deriveExactPermissionRules({
        webfetch: { 'https://x.example': 'maybe' },
      }),
    ).toEqual([]);
  });
});

describe('createPermissionRulesBridge', () => {
  beforeEach(() => {
    __resetPermissionRulesWarningForTesting();
  });

  test('(a) applies exact-match rules on a plugin-managed child session', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      permission: {
        rules: async (input) => {
          calls.push(input);
          return {};
        },
      },
    });

    await bridge.observeSessionCreated(makeChildCreatedEvent({}));

    expect(calls).toEqual([
      { sessionID: 'ses_child_1', permissions: EXACT_RULES },
    ]);
  });

  test('(a-legacy) reads the legacy `properties` payload spelling', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      permission: {
        rules: async (input) => {
          calls.push(input);
          return {};
        },
      },
    });

    await bridge.observeSessionCreated(makeChildCreatedEvent({}, 'properties'));

    expect(calls).toHaveLength(1);
    expect(calls[0].sessionID).toBe('ses_child_1');
  });

  test('(c) duplicate session.created for the same sessionID applies once', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      permission: {
        rules: async (input) => {
          calls.push(input);
          return {};
        },
      },
    });

    const event = makeChildCreatedEvent({});
    await bridge.observeSessionCreated(event);
    await bridge.observeSessionCreated(event);
    await bridge.observeSessionCreated(makeChildCreatedEvent({}, 'properties'));

    expect(calls).toHaveLength(1);
  });

  test('(b) absent capability: no-op with a one-time deterministic warning', async () => {
    const warnings: string[] = [];
    const onUnavailable = () => warnings.push('warn');

    // Host without a permission domain at all (pre-2.0.0)...
    const domainless = makeBridge({ onUnavailable });
    await domainless.observeSessionCreated(makeChildCreatedEvent({}));
    // ...and a host whose domain lacks the rules method. Both take the
    // same capability-probe path.
    const ruleless = makeBridge({ permission: {}, onUnavailable });
    await ruleless.observeSessionCreated(
      makeChildCreatedEvent({ sessionID: 'ses_child_2' }),
    );

    // ONE warning per plugin process (module-global latch), never faked
    // success: no rules were applied anywhere.
    expect(warnings).toHaveLength(1);

    // The latch is the only repeat-suppressor: after a reset the next
    // degraded host observation warns again (once).
    __resetPermissionRulesWarningForTesting();
    await ruleless.observeSessionCreated(
      makeChildCreatedEvent({ sessionID: 'ses_child_3' }),
    );
    expect(warnings).toHaveLength(2);
  });

  test('(d) emitted rules never contain wildcard characters', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      permission: {
        rules: async (input) => {
          calls.push(input);
          return {};
        },
      },
    });

    await bridge.observeSessionCreated(makeChildCreatedEvent({}));

    expect(calls).toHaveLength(1);
    expect(calls[0].permissions).toHaveLength(EXACT_RULES.length);
    for (const rule of calls[0].permissions) {
      expect(rule.action).not.toMatch(/[*?]/);
      expect(rule.resource).not.toMatch(/[*?]/);
      expect(['allow', 'deny', 'ask']).toContain(rule.effect);
    }
  });

  test('(e) a throwing rules() is absorbed, never thrown into the pump', async () => {
    const bridge = makeBridge({
      permission: {
        rules: async () => {
          throw new Error('host rejected the ruleset');
        },
      },
    });

    await expect(
      bridge.observeSessionCreated(makeChildCreatedEvent({})),
    ).resolves.toBeUndefined();
    // Every retry attempt stays fail-soft; the retry itself is covered
    // by (e-retry).
    await expect(
      bridge.observeSessionCreated(makeChildCreatedEvent({})),
    ).resolves.toBeUndefined();
  });

  test('(e-retry) a failed application is retried by a duplicate session.created', async () => {
    // Regression (review on #1194): the applied marker used to be set
    // before the host call, so a rejected rules() permanently stranded
    // the child on inherited session rules. Completion must latch only
    // on success; failure releases the slot for the next event.
    let attempts = 0;
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      permission: {
        rules: async (input) => {
          attempts += 1;
          if (attempts === 1) throw new Error('transient host failure');
          calls.push(input);
          return {};
        },
      },
    });

    await expect(
      bridge.observeSessionCreated(makeChildCreatedEvent({})),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(1);

    // A duplicate event retries the failed application and succeeds.
    await bridge.observeSessionCreated(makeChildCreatedEvent({}));
    expect(attempts).toBe(2);
    expect(calls).toHaveLength(1);

    // Success latches: further duplicates do not re-apply.
    await bridge.observeSessionCreated(makeChildCreatedEvent({}));
    expect(attempts).toBe(2);
  });

  test('malformed events resolve without throwing (fail-soft)', async () => {
    const bridge = makeBridge({
      permission: {
        rules: async () => {
          throw new Error('must not be called');
        },
      },
    });
    await expect(
      bridge.observeSessionCreated(undefined as never),
    ).resolves.toBeUndefined();
    await expect(
      bridge.observeSessionCreated({ type: 'session.created' }),
    ).resolves.toBeUndefined();
    await expect(
      bridge.observeSessionCreated({
        type: 'session.execution.started',
        data: { sessionID: 'ses_child_1' },
      }),
    ).resolves.toBeUndefined();
  });

  test('root sessions (no parentID) are never touched', async () => {
    const calls: RulesCall[] = [];
    const warnings: string[] = [];
    const bridge = makeBridge({
      permission: {
        rules: async (input) => {
          calls.push(input);
          return {};
        },
      },
      onUnavailable: () => warnings.push('warn'),
    });

    await bridge.observeSessionCreated(
      makeChildCreatedEvent({ parentID: undefined }),
    );

    // ctx.permission.rules REPLACES the session-scoped list — a root
    // session must not even probe the capability.
    expect(calls).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test('child sessions of foreign agents are never touched', async () => {
    const calls: RulesCall[] = [];
    const warnings: string[] = [];
    const bridge = makeBridge({
      permission: {
        rules: async (input) => {
          calls.push(input);
          return {};
        },
      },
      pluginAgents: new Set(['probe']),
      onUnavailable: () => warnings.push('warn'),
    });

    // agent 'build' is a host/user agent, not plugin-defined
    await bridge.observeSessionCreated(
      makeChildCreatedEvent({ agent: 'build' }),
    );
    // no agent on the event at all — attribution impossible, skip
    await bridge.observeSessionCreated(
      makeChildCreatedEvent({ agent: undefined }),
    );

    expect(calls).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test('an empty exact-match derivation skips the host call', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      permission: {
        rules: async (input) => {
          calls.push(input);
          return {};
        },
      },
      // read-only policies are whole-tool effects only: nothing to apply
      policy: { edit: 'deny', read: 'allow' },
    });

    await bridge.observeSessionCreated(makeChildCreatedEvent({}));
    await bridge.observeSessionCreated(makeChildCreatedEvent({}));

    expect(calls).toHaveLength(0);
  });
});

/** Event stream that yields the given events, then parks forever (the
 * pump keeps consuming until dispose). */
function eventIterable(
  events: Array<Record<string, unknown>>,
): AsyncIterable<Record<string, unknown>> {
  let index = 0;
  return {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<Record<string, unknown>>> => {
        if (index < events.length) {
          return Promise.resolve({ value: events[index++], done: false });
        }
        return new Promise(() => {});
      },
      return: () =>
        Promise.resolve({
          value: undefined,
          done: true,
        } as IteratorResult<Record<string, unknown>>),
    }),
  };
}

describe('createV2Setup permission rules wiring', () => {
  let originalEnv: typeof process.env;
  let fixtureRoot: string;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    fixtureRoot = await mkdtemp('/tmp/omo-v2-perm-rules-');
    const configDir = path.join(fixtureRoot, 'config');
    await Bun.write(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      // Minimal hermetic fixture (mirrors setup-compaction.test.ts) plus
      // one exact-match task-policy entry on a default agent, so the
      // wiring test has a derivable rule waiting for the child event.
      JSON.stringify({
        companion: { enabled: false },
        agents: {
          explorer: {
            permission: {
              // Nested pattern maps are schema-valid on bash (the
              // whole-tool keys like webfetch take plain actions only).
              bash: { 'git push': 'ask' },
            },
          },
        },
      }),
    );
    process.env = {
      ...originalEnv,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_CONFIG_HOME: path.join(fixtureRoot, 'xdg-config'),
      XDG_DATA_HOME: path.join(fixtureRoot, 'xdg-data'),
      XDG_CACHE_HOME: path.join(fixtureRoot, 'xdg-cache'),
      OPENCODE_LOG_DIR: path.join(fixtureRoot, 'logs'),
    };
    delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
    __resetPermissionRulesWarningForTesting();
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  test('the event pump applies child session rules via ctx.permission.rules', async () => {
    const calls: RulesCall[] = [];
    const projectDir = path.join(fixtureRoot, 'project');
    const ctx = {
      app: { name: 'opencode', version: 'v2-perm-rules-test' },
      options: {},
      location: {
        directory: projectDir,
        project: {
          id: 'proj_perm_rules',
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
        hook: async () => ({ dispose: () => {} }),
      },
      permission: {
        rules: async (input: RulesCall) => {
          calls.push(input);
          return {};
        },
      },
      event: {
        subscribe: () =>
          eventIterable([
            {
              type: 'session.created',
              data: {
                sessionID: 'ses_probe_child',
                parentID: 'ses_probe_parent',
                agent: 'explorer',
              },
            },
          ]),
      },
    } as unknown as V2Context;

    const cleanup = await createV2Setup()(ctx);

    try {
      // The pump dispatches asynchronously; poll briefly for the apply.
      const deadline = Date.now() + 10_000;
      while (calls.length === 0 && Date.now() < deadline) {
        await Bun.sleep(25);
      }
      expect(calls).toHaveLength(1);
      expect(calls[0].sessionID).toBe('ses_probe_child');
      // The fixture's exact-match entry made it through the derivation
      // (v1 `bash` maps to the v2 `execute` + `bash` actions).
      expect(calls[0].permissions).toContainEqual({
        action: 'execute',
        resource: 'git push',
        effect: 'ask',
      });
      expect(calls[0].permissions).toContainEqual({
        action: 'bash',
        resource: 'git push',
        effect: 'ask',
      });
      // Whatever else the resolved task-policy contributed stays
      // wildcard-free (skill entries and the like).
      for (const rule of calls[0].permissions) {
        expect(rule.action).not.toMatch(/[*?]/);
        expect(rule.resource).not.toMatch(/[*?]/);
      }
    } finally {
      await cleanup();
    }
  }, 20_000);
});
