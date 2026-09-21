/**
 * v2 per-session permission rules bridge (`ctx.session.update` with a
 * `permissions` payload, v2.0.5).
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
 * - (b) hosts without `session.update` no-op with a ONE-TIME
 *   deterministic warning (the commit-2bf290ad degradation pattern)
 * - (c) duplicate session.created delivery for the same sessionID is
 *   idempotent (applied exactly once per child)
 * - (d) emitted rules contain no wildcard characters (`*`, `?`)
 * - (e) failures are logged, never thrown into the event pump
 * - matrix: every built-in agent derives a non-empty, declaration-
 *   faithful exact ruleset — whole-tool declarations included (resource
 *   = the declared tool key), so read-only agents (which declare their
 *   capability set as whole-tool effects) never strand a child on the
 *   parent's inherited session rules
 * - gates: root sessions (no parentID) and foreign agents are never
 *   touched (session.update's `permissions` payload REPLACES the
 *   session-scoped list)
 * - wiring: the createV2Setup event pump dispatches raw session.created
 *   events into the bridge (full-setup test, fixture pattern from
 *   setup-compaction.test.ts)
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { createAgents } from '../agents/index';
import { PluginConfigSchema } from '../config';
import { RuntimeConfig } from '../config/runtime';
import {
  createPermissionRulesBridge,
  createV2Setup,
  deriveExactPermissionRules,
  resetV2GenerationWarnings,
} from './setup';
import type { V2Context, V2PermissionRule, V2Session } from './types';

/** Task-policy fixture: nested exact patterns alongside entries that
 * cannot be expressed exactly (the '*' catch-all key, wildcard resource
 * patterns). Whole-tool string effects derive an action-scoped rule
 * (resource = the declared tool key); nested wildcard patterns and the
 * catch-all key remain underivable. */
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
 * v1→v2 action mapping (bash → execute+bash, task → subagent). The
 * whole-tool `edit: 'deny'` derives its action-scoped rule (resource =
 * the declared tool key); only the wildcard shapes are skipped. */
const EXACT_RULES: V2PermissionRule[] = [
  { action: 'edit', resource: 'edit', effect: 'deny' },
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

/** Session-domain stub: `update` captures when a function is given; the
 * no-argument shape is a reduced-host session domain without `update`. */
function makeSession(update?: (input: unknown) => Promise<unknown>): V2Session {
  return (update ? { update } : {}) as unknown as V2Session;
}

function makeBridge(options?: {
  session?: V2Session;
  policy?: unknown;
  pluginAgents?: ReadonlySet<string>;
  onUnavailable?: () => void;
}): ReturnType<typeof createPermissionRulesBridge> {
  return createPermissionRulesBridge(options?.session, {
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

  test('whole-tool effects derive action-scoped rules; the string shorthand is skipped', () => {
    // A whole-tool effect (edit: 'deny') covers every resource of the
    // tool; the tool key itself is the one exact resource the
    // declaration names, so the rule's scope stays a subset of the
    // declaration. The string shorthand applies to every ACTION and
    // still cannot be emitted.
    expect(deriveExactPermissionRules('ask')).toEqual([]);
    expect(deriveExactPermissionRules({ edit: 'deny', read: 'allow' })).toEqual(
      [
        { action: 'edit', resource: 'edit', effect: 'deny' },
        { action: 'read', resource: 'read', effect: 'allow' },
      ],
    );
    // v1→v2 action aliasing applies to whole-tool entries too.
    expect(deriveExactPermissionRules({ bash: 'deny' })).toEqual([
      { action: 'execute', resource: 'bash', effect: 'deny' },
      { action: 'bash', resource: 'bash', effect: 'deny' },
    ]);
    expect(deriveExactPermissionRules({ task: 'deny' })).toEqual([
      { action: 'subagent', resource: 'task', effect: 'deny' },
    ]);
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
    expect(deriveExactPermissionRules({ read: 'maybe' })).toEqual([]);
  });
});

// ── Built-in agent derivation matrix (incident: explorer derived 0 rules) ──

/** v1 tool keys the v2 evaluator addresses under a different action name. */
const V1_KEY_TO_V2_ACTIONS: Record<string, readonly string[]> = {
  task: ['subagent'],
  bash: ['execute', 'bash'],
};

function v2ActionsForV1Key(key: string): readonly string[] {
  return V1_KEY_TO_V2_ACTIONS[key] ?? [key];
}

type AgentPermissionMap = Record<
  string,
  'allow' | 'ask' | 'deny' | Record<string, 'allow' | 'ask' | 'deny'>
>;

/** Every whole-tool declaration (wildcard-free key, valid effect) must
 * survive derivation as an action-scoped exact rule per v2 action. */
function coversWholeToolDeclarations(
  rules: V2PermissionRule[],
  map: AgentPermissionMap,
): boolean {
  for (const [tool, value] of Object.entries(map)) {
    if (typeof value !== 'string') continue;
    if (value !== 'allow' && value !== 'deny' && value !== 'ask') continue;
    if (tool.includes('*') || tool.includes('?')) continue;
    for (const action of v2ActionsForV1Key(tool)) {
      if (
        !rules.some(
          (rule) =>
            rule.action === action &&
            rule.resource === tool &&
            rule.effect === value,
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

/** No-widening gate: every derived rule must trace back to a declaration —
 * either the whole-tool entry its resource names, or a nested non-wildcard
 * pattern entry on a tool key that maps to the rule's action. */
function everyRuleIsDeclared(
  rules: V2PermissionRule[],
  map: AgentPermissionMap,
): boolean {
  for (const rule of rules) {
    const declared = Object.entries(map).some(([tool, value]) => {
      if (!v2ActionsForV1Key(tool).includes(rule.action)) return false;
      if (rule.resource.includes('*') || rule.resource.includes('?'))
        return false;
      if (value === rule.effect && rule.resource === tool) return true;
      return (
        !!value &&
        typeof value === 'object' &&
        value[rule.resource] === rule.effect
      );
    });
    if (!declared) return false;
  }
  return true;
}

function rulesAreWildcardFree(rules: V2PermissionRule[]): boolean {
  return rules.every(
    (rule) => !rule.action.match(/[*?]/) && !rule.resource.match(/[*?]/),
  );
}

/** Real resolved permission maps from the production agent pipeline
 * (createAgents + applyDefaultPermissions — exactly what the bridge's
 * permissionForAgent receives via the config() hook). Council mode is
 * enabled so the councillor (the one built-in that DECLARES a read-only
 * tool set) and the synthesis-only council agent are part of the matrix. */
function builtInAgentPermissionMaps(): Map<string, AgentPermissionMap> {
  const dir = 'v2-perm-rules-matrix';
  RuntimeConfig.reset(dir);
  RuntimeConfig.init(
    dir,
    PluginConfigSchema.parse({
      council: {
        presets: { default: { alpha: { model: 'test/councillor' } } },
      },
    }),
  );
  const maps = new Map<string, AgentPermissionMap>();
  for (const agent of createAgents(RuntimeConfig.get(dir))) {
    maps.set(agent.name, (agent.config.permission ?? {}) as AgentPermissionMap);
  }
  return maps;
}

describe('built-in agent permission-rule derivation matrix', () => {
  // Shared, computed once: deriving from the real resolved maps keeps the
  // matrix honest against definition drift.
  let maps: Map<string, AgentPermissionMap>;
  beforeAll(() => {
    maps = builtInAgentPermissionMaps();
  });

  test('the expected built-in roster is present', () => {
    for (const name of [
      'orchestrator',
      'explorer',
      'librarian',
      'oracle',
      'designer',
      'fixer',
      'council',
      'councillor',
    ]) {
      expect(maps.has(name), `agent ${name} missing from matrix`).toBe(true);
    }
  });

  test.each([
    'orchestrator',
    'explorer',
    'librarian',
    'oracle',
    'designer',
    'fixer',
    'council',
    'councillor',
  ])('%s derives a non-empty, declaration-faithful rule set', (name) => {
    const map = maps.get(name) as AgentPermissionMap;
    const rules = deriveExactPermissionRules(map);
    // Incident fix: 0 rules meant the bridge skipped session.update and
    // the child stayed on inherited parent session rules.
    expect(rules.length).toBeGreaterThan(0);
    expect(rulesAreWildcardFree(rules)).toBe(true);
    expect(coversWholeToolDeclarations(rules, map)).toBe(true);
    expect(everyRuleIsDeclared(rules, map)).toBe(true);
  });

  test('councillor (declared read-only set) derives read-class allow rules', () => {
    const rules = deriveExactPermissionRules(
      maps.get('councillor') as AgentPermissionMap,
    );
    for (const action of [
      'read',
      'glob',
      'grep',
      'lsp',
      'list',
      'codesearch',
      'ast_grep_search',
    ]) {
      expect(rules).toContainEqual({
        action,
        resource: action,
        effect: 'allow',
      });
    }
    // The declared write-class boundary is carried too.
    for (const action of ['edit', 'write', 'apply_patch']) {
      expect(rules).toContainEqual({
        action,
        resource: action,
        effect: 'deny',
      });
    }
  });

  test('council (synthesis-only) derives no allow rules', () => {
    const rules = deriveExactPermissionRules(
      maps.get('council') as AgentPermissionMap,
    );
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((rule) => rule.effect !== 'allow')).toBe(true);
  });

  test('explorer row (incident): bridge applies the derived rules to the child session', async () => {
    const calls: RulesCall[] = [];
    const bridge = createPermissionRulesBridge(
      makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
      {
        permissionForAgent: (agent) => maps.get(agent),
        pluginAgents: new Set(maps.keys()),
      },
    );

    await bridge.observeSessionCreated(
      makeChildCreatedEvent({ agent: 'explorer' }),
    );

    // Before the fix this was 0 calls ("no exact-match rules derivable")
    // and the child kept the parent's inherited session-scoped rules.
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionID).toBe('ses_child_1');
    expect(calls[0].permissions.length).toBeGreaterThan(0);
    expect(rulesAreWildcardFree(calls[0].permissions)).toBe(true);
    expect(calls[0].permissions).toContainEqual({
      action: 'question',
      resource: 'question',
      effect: 'allow',
    });
  });

  test('councillor row: applied rules include the read-class allows', async () => {
    const calls: RulesCall[] = [];
    const bridge = createPermissionRulesBridge(
      makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
      {
        permissionForAgent: (agent) => maps.get(agent),
        pluginAgents: new Set(maps.keys()),
      },
    );

    await bridge.observeSessionCreated(
      makeChildCreatedEvent({ agent: 'councillor' }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].permissions).toContainEqual({
      action: 'read',
      resource: 'read',
      effect: 'allow',
    });
    expect(calls[0].permissions).toContainEqual({
      action: 'grep',
      resource: 'grep',
      effect: 'allow',
    });
  });
});

describe('createPermissionRulesBridge', () => {
  beforeEach(() => {
    resetV2GenerationWarnings();
  });

  test('(a) applies exact-match rules on a plugin-managed child session', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
    });

    await bridge.observeSessionCreated(makeChildCreatedEvent({}));

    expect(calls).toEqual([
      { sessionID: 'ses_child_1', permissions: EXACT_RULES },
    ]);
  });

  test('(a-legacy) reads the legacy `properties` payload spelling', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
    });

    await bridge.observeSessionCreated(makeChildCreatedEvent({}, 'properties'));

    expect(calls).toHaveLength(1);
    expect(calls[0].sessionID).toBe('ses_child_1');
  });

  test('(c) duplicate session.created for the same sessionID applies once', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
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

    // Host without a session domain at all...
    const domainless = makeBridge({ onUnavailable });
    await domainless.observeSessionCreated(makeChildCreatedEvent({}));
    // ...and a host whose session domain lacks the update method. Both
    // take the same capability-probe path.
    const updateless = makeBridge({
      session: makeSession(),
      onUnavailable,
    });
    await updateless.observeSessionCreated(
      makeChildCreatedEvent({ sessionID: 'ses_child_2' }),
    );

    // ONE warning per plugin process (module-global latch), never faked
    // success: no rules were applied anywhere.
    expect(warnings).toHaveLength(1);

    // The latch is the only repeat-suppressor: after a reset the next
    // degraded host observation warns again (once).
    resetV2GenerationWarnings();
    await updateless.observeSessionCreated(
      makeChildCreatedEvent({ sessionID: 'ses_child_3' }),
    );
    expect(warnings).toHaveLength(2);
  });

  test('(d) emitted rules never contain wildcard characters', async () => {
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
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

  test('(e) a throwing update() is absorbed, never thrown into the pump', async () => {
    const bridge = makeBridge({
      session: makeSession(async () => {
        throw new Error('host rejected the ruleset');
      }),
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
    // before the host call, so a rejected update() permanently stranded
    // the child on inherited session rules. Completion must latch only
    // on success; failure releases the slot for the next event.
    let attempts = 0;
    const calls: RulesCall[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient host failure');
        calls.push(input as RulesCall);
        return {};
      }),
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
      session: makeSession(async () => {
        throw new Error('must not be called');
      }),
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
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
      onUnavailable: () => warnings.push('warn'),
    });

    await bridge.observeSessionCreated(
      makeChildCreatedEvent({ parentID: undefined }),
    );

    // session.update `permissions` REPLACES the session-scoped list — a
    // root session must not even probe the capability.
    expect(calls).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test('child sessions of foreign agents are never touched', async () => {
    const calls: RulesCall[] = [];
    const warnings: string[] = [];
    const bridge = makeBridge({
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
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
      session: makeSession(async (input) => {
        calls.push(input as RulesCall);
        return {};
      }),
      // Wildcard-only shapes are the genuinely underivable case: the
      // catch-all key needs a wildcard on both axes and the MCP-style
      // suffixed key carries one in the action.
      policy: { '*': 'deny', 'github_*': 'allow' },
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
    resetV2GenerationWarnings();
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  test('the event pump applies child session rules via ctx.session.update', async () => {
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
        update: async (input: RulesCall) => {
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
