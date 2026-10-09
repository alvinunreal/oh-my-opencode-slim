import { describe, expect, test } from 'bun:test';
import { createReadOnlyAgentPermission } from '../agents/permissions';
import { PermissionConfigSchema } from '../config/schema';
import {
  adaptPermissions,
  adaptTool,
  applyAgentToDraft,
  compileAgentPermissions,
  parseModelRef,
  snapshotNativeAgentForRegistry,
} from './adapters';
import type { V2AgentDraft } from './types';

function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern === value) return true;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function evaluatePermission(
  rules: Array<{ action: string; resource: string; effect: string }>,
  tool: string,
  resource = '*',
): string {
  const match = [...rules]
    .reverse()
    .find((r) => globMatch(r.action, tool) && globMatch(r.resource, resource));
  return match?.effect ?? 'ask';
}

describe('parseModelRef', () => {
  test('parses provider/model', () => {
    expect(parseModelRef('anthropic/claude-3.5')).toEqual({
      providerID: 'anthropic',
      id: 'claude-3.5',
    });
  });

  test('retains nested spaced model suffixes after the first slash', () => {
    expect(parseModelRef('opencode-omniroute-live/of/MiniMax M3')).toEqual({
      providerID: 'opencode-omniroute-live',
      id: 'of/MiniMax M3',
    });
  });

  test('undefined for non-string', () => {
    expect(parseModelRef(undefined)).toBeUndefined();
    expect(parseModelRef(42)).toBeUndefined();
  });

  test('undefined when no provider separator', () => {
    expect(parseModelRef('claude')).toBeUndefined();
  });

  test('undefined for degenerate slashes', () => {
    expect(parseModelRef('/claude')).toBeUndefined(); // empty provider
    expect(parseModelRef('anthropic/')).toBeUndefined(); // empty id
  });
});

describe('adaptTool agent context', () => {
  test('does not invent orchestrator identity for marketplace tools', async () => {
    let capturedAgent: string | undefined = 'not-called';
    const marketplaceTool = adaptTool(
      'marketplace_manage',
      {
        execute: async (_args, context) => {
          capturedAgent = (context as { agent?: string }).agent;
          return 'ok';
        },
      },
      '/project',
      {},
    );

    await marketplaceTool.execute({}, undefined);
    expect(capturedAgent).toBeUndefined();
  });

  test('preserves legacy missing-agent context for unrelated tools', async () => {
    let capturedAgent: string | undefined;
    const unrelatedTool = adaptTool(
      'task_status',
      {
        execute: async (_args, context) => {
          capturedAgent = (context as { agent?: string }).agent;
          return 'ok';
        },
      },
      '/project',
      {},
    );

    await unrelatedTool.execute({}, undefined);
    expect(capturedAgent).toBe('orchestrator');
  });
});

describe('adaptPermissions', () => {
  test('returns the v2 permissive base for no permission', () => {
    const rules = adaptPermissions(undefined);
    // Must include the broad allow so v2-native tools (subagent, execute) work.
    expect(rules).toContainEqual({
      action: '*',
      resource: '*',
      effect: 'allow',
    });
    expect(rules.length).toBeGreaterThanOrEqual(5);
  });

  test('shorthand string applies to everything', () => {
    const rules = adaptPermissions('ask');
    expect(rules.at(-1)).toEqual({ action: '*', resource: '*', effect: 'ask' });
  });

  test('maps v1 task -> v2 subagent', () => {
    const rules = adaptPermissions({ task: 'allow' });
    expect(rules).toContainEqual({
      action: 'subagent',
      resource: '*',
      effect: 'allow',
    });
  });

  test('compiles observer-only task patterns in last-match order', () => {
    const rules = adaptPermissions({
      task: { '*': 'deny', observer: 'allow' },
    });
    const subagent = rules
      .filter((rule) => rule.action === 'subagent')
      .map((rule) => [rule.resource, rule.effect]);
    // Evaluators use findLast: '*' deny first, observer allow last.
    expect(subagent).toEqual([
      ['*', 'deny'],
      ['observer', 'allow'],
    ]);
  });

  test('maps v1 bash -> v2 execute and bash', () => {
    const rules = adaptPermissions({ bash: 'deny' });
    expect(rules).toContainEqual({
      action: 'execute',
      resource: '*',
      effect: 'deny',
    });
    expect(rules).toContainEqual({
      action: 'bash',
      resource: '*',
      effect: 'deny',
    });
  });

  test('nested permission object becomes action=tool, resource=pattern', () => {
    const rules = adaptPermissions({ skill: { codemap: 'allow' } });
    expect(rules).toContainEqual({
      action: 'skill',
      resource: 'codemap',
      effect: 'allow',
    });
  });

  test('explicit deny is appended after the permissive base (last-wins)', () => {
    // v2 evaluates with findLast, so a deny must come after the base * * allow
    // to actually deny.
    const rules = adaptPermissions({ webfetch: 'deny' });
    const denyIdx = rules.findIndex(
      (r) => r.action === 'webfetch' && r.effect === 'deny',
    );
    const broadAllowIdx = rules.findIndex(
      (r) => r.action === '*' && r.resource === '*' && r.effect === 'allow',
    );
    expect(denyIdx).toBeGreaterThan(broadAllowIdx);
  });

  test('read-only councillor permissions allow glob/grep/read on real paths', () => {
    const rules = adaptPermissions(createReadOnlyAgentPermission());
    expect(evaluatePermission(rules, 'glob', 'src/**/*.ts')).toBe('allow');
    expect(evaluatePermission(rules, 'grep', 'src/v2/adapters.ts')).toBe(
      'allow',
    );
    expect(evaluatePermission(rules, 'read', 'src/v2/adapters.ts')).toBe(
      'allow',
    );
    expect(evaluatePermission(rules, 'edit', 'src/v2/adapters.ts')).toBe(
      'deny',
    );
    expect(evaluatePermission(rules, 'bash', 'ls')).toBe('deny');
  });

  test('config-parsed permissions keep author order through the pipeline', () => {
    // Regression: zod's shaped object emitted declared keys first and
    // catchall keys after, moving the author's "*": "deny" base BEHIND the
    // specific allows — under last-match-wins that denied the allows, so a
    // read-only preset lost every file tool. The record parse must keep
    // the author's key order, and the compiled rules must keep the
    // wildcard deny before the allows.
    const parsed = PermissionConfigSchema.parse({
      '*': 'deny',
      bash: 'deny',
      edit: 'deny',
      write: 'deny',
      apply_patch: 'deny',
      ast_grep_replace: 'deny',
      task: 'deny',
      question: 'deny',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      lsp: 'allow',
      list: 'allow',
      codesearch: 'allow',
      ast_grep_search: 'allow',
      external_directory: 'allow',
    });
    expect(Object.keys(parsed).at(0)).toBe('*');
    const rules = adaptPermissions(parsed);
    const wildcardDenyIdx = rules.findIndex(
      (r) => r.action === '*' && r.resource === '*' && r.effect === 'deny',
    );
    const readAllowIdx = rules.findIndex(
      (r) => r.action === 'read' && r.resource === '*' && r.effect === 'allow',
    );
    expect(wildcardDenyIdx).toBeLessThan(readAllowIdx);
    expect(evaluatePermission(rules, 'read', 'src/v2/adapters.ts')).toBe(
      'allow',
    );
    expect(evaluatePermission(rules, 'glob', 'src/**/*.ts')).toBe('allow');
    expect(evaluatePermission(rules, 'edit', 'src/v2/adapters.ts')).toBe(
      'deny',
    );
    expect(evaluatePermission(rules, 'bash', 'ls')).toBe('deny');
  });
});

describe('compileAgentPermissions', () => {
  test('native host allow overrides an earlier v1 baseline denial', () => {
    const rules = compileAgentPermissions(
      { edit: 'deny' },
      {
        hostRules: [{ action: 'edit', resource: '*', effect: 'allow' }],
      },
    );

    expect(evaluatePermission(rules, 'edit')).toBe('allow');
  });

  test('final denials remain after host rules', () => {
    const rules = compileAgentPermissions(
      { edit: 'deny' },
      {
        hostRules: [{ action: 'edit', resource: '*', effect: 'allow' }],
        finalDenials: ['edit'],
      },
    );

    expect(evaluatePermission(rules, 'edit')).toBe('deny');
  });

  test('action ceilings remain after host rules', () => {
    const rules = compileAgentPermissions(
      { edit: 'deny' },
      {
        hostRules: [{ action: 'edit', resource: '*', effect: 'allow' }],
        ceilings: {
          actions: { edit: 'deny' },
          namespaces: [],
        },
      },
    );

    expect(evaluatePermission(rules, 'edit')).toBe('deny');
  });

  test('preserves native ordered exceptions after the v1 baseline', () => {
    const rules = compileAgentPermissions(undefined, {
      hostRules: [
        { action: 'read', resource: 'src/**', effect: 'deny' },
        { action: 'read', resource: 'src/public.ts', effect: 'allow' },
      ],
    });
    expect(evaluatePermission(rules, 'read', 'src/private.ts')).toBe('deny');
    expect(evaluatePermission(rules, 'read', 'src/public.ts')).toBe('allow');
    expect(evaluatePermission(rules, 'subagent')).toBe('allow');
  });

  test('applies final denials and action, namespace, and resource ceilings', () => {
    const rules = compileAgentPermissions(undefined, {
      hostRules: [{ action: '*', resource: '*', effect: 'allow' }],
      ceilings: {
        actions: { read: 'ask' },
        namespaces: ['context7_*'],
        namespaceEffects: { 'context7_*': 'deny' },
        resources: { read: { 'private/**': 'deny' } },
      },
      finalDenials: ['execute'],
    });
    expect(evaluatePermission(rules, 'read', 'public.ts')).toBe('ask');
    expect(evaluatePermission(rules, 'read', 'private/key.ts')).toBe('deny');
    expect(evaluatePermission(rules, 'context7_search')).toBe('deny');
    expect(evaluatePermission(rules, 'execute')).toBe('deny');
    expect(evaluatePermission(rules, 'unadmitted_action')).toBe('deny');
  });
});

describe('applyAgentToDraft', () => {
  function recorder(): {
    draft: V2AgentDraft;
    calls: Array<{ id: string; agent: Record<string, unknown> }>;
  } {
    const calls: Array<{ id: string; agent: Record<string, unknown> }> = [];
    const draft: V2AgentDraft = {
      list: () => [],
      get: () => undefined,
      default: () => {},
      remove: () => {},
      update: (id, update) => {
        const agent: Record<string, unknown> = {};
        update(agent);
        calls.push({ id, agent });
      },
    };
    return { draft, calls };
  }

  test('sets id/name/mode and passes the prompt through to system', () => {
    const { draft, calls } = recorder();
    applyAgentToDraft(draft, 'explorer', {
      description: 'recon',
      prompt: "Delegate via task(subagent_type='x')",
      mode: 'subagent',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('explorer');
    expect(calls[0].agent).toMatchObject({
      id: 'explorer',
      name: 'explorer',
      mode: 'subagent',
      description: 'recon',
      system: "Delegate via task(subagent_type='x')",
    });
  });

  test('defaults orchestrator to primary mode', () => {
    const { draft, calls } = recorder();
    applyAgentToDraft(draft, 'orchestrator', {});
    expect(calls[0].agent.mode).toBe('primary');
  });

  test('parses model into a Model.Ref', () => {
    const { draft, calls } = recorder();
    applyAgentToDraft(draft, 'a', { model: 'anthropic/claude' });
    expect(calls[0].agent.model).toEqual({
      id: 'claude',
      providerID: 'anthropic',
    });
  });

  test('omits an unspecified temperature from request settings', () => {
    const { draft, calls } = recorder();
    applyAgentToDraft(draft, 'a', {});

    const request = calls[0].agent.request as Record<string, unknown>;
    expect(
      Object.hasOwn(
        (request.settings as Record<string, unknown> | undefined) ?? {},
        'temperature',
      ),
    ).toBe(false);
  });

  test('passes an explicit temperature to request settings', () => {
    const { draft, calls } = recorder();
    applyAgentToDraft(draft, 'a', { temperature: 0 });

    const request = calls[0].agent.request as Record<string, unknown>;
    expect((request.settings as Record<string, unknown>).temperature).toBe(0);
  });

  test('maps options into request.body (provider options are not dropped)', () => {
    const { draft, calls } = recorder();
    applyAgentToDraft(draft, 'a', {
      options: { thinking: { type: 'enabled', budgetTokens: 4096 } },
    });

    const request = calls[0].agent.request as Record<string, unknown>;
    expect(request.body).toEqual({
      thinking: { type: 'enabled', budgetTokens: 4096 },
    });
  });

  test('ignores array/null options in request.body', () => {
    const { draft, calls } = recorder();
    applyAgentToDraft(draft, 'a', { options: [1, 2] as never });
    applyAgentToDraft(draft, 'b', { options: null as never });

    for (const call of calls) {
      const request = call.agent.request as Record<string, unknown>;
      expect(request.body).toBeUndefined();
    }
  });

  test('clears an existing model when the finalized config inherits it', () => {
    const calls: Array<Record<string, unknown>> = [];
    const draft: V2AgentDraft = {
      list: () => [],
      get: () => undefined,
      default: () => {},
      remove: () => {},
      update: (_id, update) => {
        const agent: Record<string, unknown> = {
          model: { providerID: 'old-provider', id: 'old-model' },
        };
        update(agent);
        calls.push(agent);
      },
    };
    applyAgentToDraft(draft, 'a', {});

    expect(calls[0]).not.toHaveProperty('model');
  });

  test('merges request fields without discarding native sibling values', () => {
    const existing = {
      settings: { topP: 0.8, temperature: 0.4 },
      headers: { authorization: 'host-token', existing: 'yes' },
      body: { hostValue: true },
    };
    const draft: V2AgentDraft = {
      list: () => [],
      get: () => undefined,
      default: () => {},
      remove: () => {},
      update: (_id, update) => {
        const agent: Record<string, unknown> = { request: existing };
        update(agent);
        expect(agent.request).toEqual({
          settings: { topP: 0.8, temperature: 0.2, frequencyPenalty: 0.1 },
          headers: {
            authorization: 'host-token',
            existing: 'yes',
            extra: 'v1',
          },
          body: { hostValue: true, extra: 'v1' },
        });
      },
    };
    applyAgentToDraft(draft, 'a', {
      temperature: 0.2,
      request: {
        settings: { frequencyPenalty: 0.1 },
        headers: { extra: 'v1' },
        body: { extra: 'v1' },
      },
    });
  });

  test('snapshots and reapplies a native agent without flattening permissions', () => {
    const native = {
      id: 'native',
      name: 'Native',
      description: 'host description',
      system: 'host system',
      mode: 'primary',
      hidden: true,
      model: { providerID: 'anthropic', id: 'claude', variant: 'thinking' },
      request: {
        settings: { temperature: 0.3, topP: 0.9 },
        headers: { 'x-host': 'kept' },
        body: { hostOption: true },
      },
      permissions: [
        { action: 'read', resource: 'private/**', effect: 'deny' },
        { action: 'read', resource: 'public/**', effect: 'allow' },
      ],
    };
    const snapshot = snapshotNativeAgentForRegistry(native);
    const { draft, calls } = recorder();
    applyAgentToDraft(draft, 'native', snapshot.config, snapshot.permissions);

    expect(snapshot.config).toMatchObject({
      model: 'anthropic/claude',
      variant: 'thinking',
      prompt: 'host system',
      mode: 'primary',
      hidden: true,
      description: 'host description',
    });
    expect(snapshot.config).not.toHaveProperty('permission');
    expect(snapshot.permissions).toEqual(native.permissions);
    expect(calls[0].agent).toMatchObject({
      model: { providerID: 'anthropic', id: 'claude', variant: 'thinking' },
      system: 'host system',
      request: {
        settings: { temperature: 0.3, topP: 0.9 },
        headers: { 'x-host': 'kept' },
        body: { hostOption: true },
      },
      permissions: native.permissions,
    });
  });

  test('model-less native agents do not override configured models', () => {
    const snapshot = snapshotNativeAgentForRegistry({ id: 'explorer' });
    expect(snapshot.config).not.toHaveProperty('model');
  });

  test('permission deny beats tools-list allow (tools first, last-wins)', () => {
    const { draft, calls } = recorder();
    applyAgentToDraft(draft, 'a', {
      tools: ['webfetch'],
      permission: { webfetch: 'deny' },
    });
    const rules = calls[0].agent.permissions as Array<Record<string, unknown>>;
    const toolsAllowIdx = rules.findIndex(
      (r) =>
        r.action === 'webfetch' && r.effect === 'allow' && r.resource === '*',
    );
    const denyIdx = rules.findIndex(
      (r) => r.action === 'webfetch' && r.effect === 'deny',
    );
    expect(toolsAllowIdx).toBeGreaterThanOrEqual(0);
    expect(denyIdx).toBeGreaterThan(toolsAllowIdx); // deny wins under findLast
  });
});
