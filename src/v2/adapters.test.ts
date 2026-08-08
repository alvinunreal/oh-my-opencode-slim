import { describe, expect, test } from 'bun:test';
import {
  adaptPermissions,
  applyAgentToDraft,
  parseModelRef,
  rewritePromptForV2,
} from './adapters';
import type { V2AgentDraft } from './types';

describe('parseModelRef', () => {
  test('parses provider/model', () => {
    expect(parseModelRef('anthropic/claude-3.5')).toEqual({
      providerID: 'anthropic',
      id: 'claude-3.5',
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

  test('maps v1 bash -> v2 execute and bash', () => {
    const rules = adaptPermissions({ bash: 'deny' });
    expect(rules).toContainEqual({
      action: '*',
      resource: 'execute',
      effect: 'deny',
    });
    expect(rules).toContainEqual({
      action: '*',
      resource: 'bash',
      effect: 'deny',
    });
  });

  test('nested permission object becomes action/resource rule', () => {
    const rules = adaptPermissions({ skill: { codemap: 'allow' } });
    expect(rules).toContainEqual({
      action: 'codemap',
      resource: 'skill',
      effect: 'allow',
    });
  });

  test('explicit deny is appended after the permissive base (last-wins)', () => {
    // v2 evaluates with findLast, so a deny must come after the base * * allow
    // to actually deny.
    const rules = adaptPermissions({ webfetch: 'deny' });
    const denyIdx = rules.findIndex(
      (r) => r.resource === 'webfetch' && r.effect === 'deny',
    );
    const broadAllowIdx = rules.findIndex(
      (r) => r.action === '*' && r.resource === '*' && r.effect === 'allow',
    );
    expect(denyIdx).toBeGreaterThan(broadAllowIdx);
  });
});

describe('rewritePromptForV2', () => {
  test('rewrites delegation call + param', () => {
    expect(
      rewritePromptForV2(
        "task(subagent_type='explorer', description='x', prompt='y')",
      ),
    ).toBe("subagent(agent='explorer', description='x', prompt='y')");
  });

  test('passes through non-strings unchanged', () => {
    expect(rewritePromptForV2(undefined)).toBeUndefined();
    expect(rewritePromptForV2(42)).toBe(42);
  });

  test('rewrites every occurrence', () => {
    expect(rewritePromptForV2('task(a)\ntask(b)')).toBe(
      'subagent(a)\nsubagent(b)',
    );
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

  test('sets id/name/mode and rewrites the prompt into system', () => {
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
      system: "Delegate via subagent(agent='x')",
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

  test('permission deny beats tools-list allow (tools first, last-wins)', () => {
    const { draft, calls } = recorder();
    applyAgentToDraft(draft, 'a', {
      tools: ['webfetch'],
      permission: { webfetch: 'deny' },
    });
    const rules = calls[0].agent.permissions as Array<Record<string, unknown>>;
    const toolsAllowIdx = rules.findIndex(
      (r) =>
        r.resource === 'webfetch' && r.effect === 'allow' && r.action === '*',
    );
    const denyIdx = rules.findIndex(
      (r) => r.resource === 'webfetch' && r.effect === 'deny',
    );
    expect(toolsAllowIdx).toBeGreaterThanOrEqual(0);
    expect(denyIdx).toBeGreaterThan(toolsAllowIdx); // deny wins under findLast
  });
});
