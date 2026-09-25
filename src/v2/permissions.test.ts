import { describe, expect, test } from 'bun:test';
import { compilePermissionPolicy, v1PermissionTargets } from './permissions';
import type { V2PermissionRule } from './types';

const allowAll: V2PermissionRule[] = [
  { action: '*', resource: '*', effect: 'allow' },
];

describe('compilePermissionPolicy', () => {
  test('honors ordered host exceptions and preserves non-marketplace rules', () => {
    const policy = compilePermissionPolicy({
      baselineRules: allowAll,
      hostRules: [
        { action: 'read', resource: 'src/**', effect: 'deny' },
        { action: 'read', resource: 'src/public.ts', effect: 'allow' },
      ],
    });

    expect(policy.decide('read', 'src/private.ts')).toBe('deny');
    expect(policy.decide('read', 'src/public.ts')).toBe('allow');
    expect(policy.decide('edit', 'outside.ts')).toBe('allow');
    expect(policy.rules).toEqual([
      ...allowAll,
      ...[
        { action: 'read', resource: 'src/**', effect: 'deny' },
        { action: 'read', resource: 'src/public.ts', effect: 'allow' },
      ],
    ]);
  });

  test('clips marketplace actions, resource ordering, and effects to ceilings', () => {
    const policy = compilePermissionPolicy({
      baselineRules: allowAll,
      hostRules: [
        { action: 'read', resource: 'src/**', effect: 'deny' },
        { action: 'read', resource: 'src/public.ts', effect: 'allow' },
      ],
      marketplace: {
        actions: { read: 'ask', edit: 'deny' },
        skills: [],
        mcpNamespaces: [],
      },
    });

    expect(policy.decide('read', 'src/private.ts')).toBe('deny');
    expect(policy.decide('read', 'src/public.ts')).toBe('ask');
    expect(policy.decide('read', 'other.ts')).toBe('ask');
    expect(emittedDecision(policy.rules, 'read', 'src/private.ts')).toBe(
      policy.decide('read', 'src/private.ts'),
    );
    expect(emittedDecision(policy.rules, 'read', 'src/public.ts')).toBe(
      policy.decide('read', 'src/public.ts'),
    );
    expect(policy.decide('edit', 'file.ts')).toBe('deny');
    expect(policy.decide('execute', 'ls')).toBe('deny');
    expect(policy.rules[0]).toEqual({
      action: '*',
      resource: '*',
      effect: 'deny',
    });
  });

  test('allows only exact admitted skill names and retains host denies', () => {
    const policy = compilePermissionPolicy({
      baselineRules: allowAll,
      hostRules: [
        { action: '*', resource: '*', effect: 'allow' },
        { action: 'skill', resource: 'blocked', effect: 'deny' },
      ],
      marketplace: {
        actions: {},
        skills: ['simplify', 'blocked'],
        mcpNamespaces: [],
      },
    });

    expect(policy.decideSkill('simplify')).toBe('allow');
    expect(policy.decideSkill('blocked')).toBe('deny');
    expect(policy.decideSkill('other')).toBe('deny');
    expect(policy.rules).toContainEqual({
      action: 'skill',
      resource: 'simplify',
      effect: 'allow',
    });
    expect(emittedDecision(policy.rules, 'skill', 'simplify')).toBe(
      policy.decideSkill('simplify'),
    );
  });

  test('keeps skill action ceilings separate from exact skill admission', () => {
    const allowPolicy = compilePermissionPolicy({
      baselineRules: [],
      hostRules: [{ action: '*', resource: '*', effect: 'allow' }],
      marketplace: {
        actions: { skill: 'allow' },
        skills: ['known'],
        mcpNamespaces: [],
      },
    });
    expect(allowPolicy.decide('skill', 'known')).toBe('allow');
    expect(allowPolicy.decideSkill('unknown')).toBe('deny');
    expect(emittedDecision(allowPolicy.rules, 'skill', 'known')).toBe(
      allowPolicy.decideSkill('known'),
    );

    const denyPolicy = compilePermissionPolicy({
      baselineRules: [],
      hostRules: [
        { action: 'skill', resource: '*', effect: 'deny' },
        { action: 'skill', resource: 'known', effect: 'allow' },
      ],
      marketplace: {
        actions: { skill: 'deny' },
        skills: ['known'],
        mcpNamespaces: [],
      },
    });
    expect(denyPolicy.decide('skill', 'known')).toBe('deny');
    expect(denyPolicy.decideSkill('known')).toBe('deny');
    expect(emittedDecision(denyPolicy.rules, 'skill', 'known')).toBe(
      denyPolicy.decideSkill('known'),
    );
  });

  test('owner skill and MCP ceilings constrain native wildcard allows without erasing host denies', () => {
    const policy = compilePermissionPolicy({
      baselineRules: allowAll,
      hostRules: [
        { action: 'skill', resource: 'already-blocked', effect: 'deny' },
        { action: 'github_*', resource: 'private/*', effect: 'deny' },
        { action: '*', resource: '*', effect: 'allow' },
      ],
      marketplace: {
        actions: { skill: 'allow' },
        skills: ['blocked', 'review', 'allowed'],
        skillEffects: { blocked: 'deny', review: 'ask' },
        mcpNamespaces: ['context7_*', 'github_*', 'other_*'],
        mcpEffects: { 'context7_*': 'deny', 'github_*': 'ask' },
      },
    });
    for (const [action, resource, expected] of [
      ['skill', 'blocked', 'deny'],
      ['skill', 'review', 'ask'],
      ['skill', 'allowed', 'allow'],
      ['skill', 'unknown', 'deny'],
      ['context7_search', '*', 'deny'],
      ['github_search', '*', 'ask'],
      ['other_search', '*', 'allow'],
      ['unknown_search', '*', 'deny'],
    ] as const) {
      expect(policy.decide(action, resource)).toBe(expected);
      expect(emittedDecision(policy.rules, action, resource)).toBe(expected);
    }
  });

  test('uses ask as the unmatched fallback inside admitted marketplace scopes', () => {
    const policy = compilePermissionPolicy({
      baselineRules: [],
      hostRules: [],
      marketplace: {
        actions: { read: 'allow', skill: 'allow' },
        skills: ['known'],
        mcpNamespaces: ['context7_*'],
      },
    });

    expect(policy.decide('read', 'file.ts')).toBe('ask');
    expect(policy.decideSkill('known')).toBe('ask');
    expect(policy.decide('context7_search', '*')).toBe('ask');
    expect(emittedDecision(policy.rules, 'read', 'file.ts')).toBe(
      policy.decide('read', 'file.ts'),
    );
    expect(emittedDecision(policy.rules, 'skill', 'known')).toBe(
      policy.decideSkill('known'),
    );
    expect(emittedDecision(policy.rules, 'context7_search', '*')).toBe(
      policy.decide('context7_search', '*'),
    );
  });

  test('intersects MCP all, exact, and prefix patterns without cross-prefix leakage', () => {
    const policy = compilePermissionPolicy({
      baselineRules: allowAll,
      hostRules: [
        { action: '*', resource: '*', effect: 'allow' },
        { action: 'context7_search', resource: '*', effect: 'deny' },
        { action: 'github_*', resource: '*', effect: 'ask' },
      ],
      marketplace: {
        actions: {},
        skills: [],
        mcpNamespaces: ['context7_*', 'github_*', 'gitlab_*'],
      },
    });

    expect(policy.decide('context7_search', '*')).toBe('deny');
    expect(policy.decide('github_tools', '*')).toBe('ask');
    expect(policy.decide('gitlab_search', '*')).toBe('allow');
    expect(policy.decide('other_search', '*')).toBe('deny');
    expect(policy.rules).not.toContainEqual({
      action: '*',
      resource: '*',
      effect: 'allow',
    });
  });

  test('preserves native MCP resource exceptions and specific baseline grants after deny-all', () => {
    const policy = compilePermissionPolicy({
      baselineRules: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'context7_*', resource: '*', effect: 'allow' },
      ],
      hostRules: [
        { action: 'context7_search', resource: 'private/*', effect: 'deny' },
        {
          action: 'context7_search',
          resource: 'private/public',
          effect: 'allow',
        },
      ],
      marketplace: {
        actions: {},
        skills: [],
        mcpNamespaces: ['context7_*'],
      },
    });
    for (const [action, resource, effect] of [
      ['context7_search', '*', 'allow'],
      ['context7_search', 'private/secret', 'deny'],
      ['context7_search', 'private/public', 'allow'],
      ['other_server_tool', '*', 'deny'],
    ] as const) {
      expect(policy.decide(action, resource)).toBe(effect);
      expect(emittedDecision(policy.rules, action, resource)).toBe(effect);
    }
    expect(policy.rules).toContainEqual({
      action: 'context7_*',
      resource: '*',
      effect: 'allow',
    });
    expect(v1PermissionTargets('task')).toEqual([
      { action: 'subagent', resource: '*' },
    ]);
  });

  test('intersects arbitrary native host globs exactly without aborting agent setup', () => {
    const hostPatterns = [
      'context7_s*',
      'context7_s?',
      '*context7*',
      'other_*',
      'context?',
      'context7_?*s?*',
    ];
    const actions = [
      'context7_',
      'context7_s',
      'context7_s1',
      'context7_search',
      'context7_something',
      'context7_ask',
      'context7_books',
      'context7_mixeds1',
      'context7_nonmatch',
      'other_context7_search',
      'other_search',
    ];
    for (const hostAction of hostPatterns) {
      const policy = compilePermissionPolicy({
        baselineRules: [],
        hostRules: [{ action: hostAction, resource: '*', effect: 'allow' }],
        marketplace: {
          actions: {},
          skills: [],
          mcpNamespaces: ['context7_*'],
        },
      });
      for (const action of actions) {
        const expected =
          matcher(action, 'context7_*') && matcher(action, hostAction)
            ? 'allow'
            : matcher(action, 'context7_*')
              ? 'ask'
              : 'deny';
        expect(emittedDecision(policy.rules, action, '*')).toBe(expected);
        expect(policy.decide(action, '*')).toBe(expected);
      }
    }
  });

  test('retains resource ordering, baseline grants, and owner ceilings for residual globs', () => {
    const policy = compilePermissionPolicy({
      baselineRules: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'context7_*', resource: '*', effect: 'allow' },
      ],
      hostRules: [
        { action: 'context7_s*', resource: 'restricted/*', effect: 'deny' },
        {
          action: 'context7_s?',
          resource: 'restricted/public',
          effect: 'allow',
        },
        { action: '*context7*', resource: 'context/*', effect: 'ask' },
        { action: 'other_*', resource: '*', effect: 'allow' },
      ],
      marketplace: {
        actions: {},
        skills: [],
        mcpNamespaces: ['context7_*'],
      },
    });
    for (const [action, resource, expected] of [
      ['context7_search', '*', 'allow'],
      ['context7_search', 'restricted/secret', 'deny'],
      ['context7_s1', 'restricted/public', 'allow'],
      ['context7_search', 'restricted/public', 'deny'],
      ['context7_books', 'context/source', 'ask'],
      ['context7_search', 'context/source', 'ask'],
      ['other_context7_search', 'context/source', 'deny'],
      ['other_search', '*', 'deny'],
    ] as const) {
      expect(emittedDecision(policy.rules, action, resource)).toBe(expected);
      expect(policy.decide(action, resource)).toBe(expected);
    }
    const restricted = compilePermissionPolicy({
      baselineRules: allowAll,
      hostRules: [{ action: 'context7_s*', resource: '*', effect: 'allow' }],
      marketplace: {
        actions: {},
        skills: [],
        mcpNamespaces: ['context7_*'],
        mcpEffects: { 'context7_*': 'ask' },
      },
    });
    expect(emittedDecision(restricted.rules, 'context7_search', '*')).toBe(
      'ask',
    );
  });

  test('intersects wildcard host rules with exact MCP ceilings using the exact value', () => {
    const matching = compilePermissionPolicy({
      baselineRules: [],
      hostRules: [{ action: 'github_search?', resource: '*', effect: 'deny' }],
      marketplace: {
        actions: {},
        skills: [],
        mcpNamespaces: ['github_search1'],
      },
    });
    expect(matching.decide('github_search1', '*')).toBe('deny');
    expect(emittedDecision(matching.rules, 'github_search1', '*')).toBe(
      matching.decide('github_search1', '*'),
    );

    const nonMatching = compilePermissionPolicy({
      baselineRules: [],
      hostRules: [{ action: 'github_search?', resource: '*', effect: 'deny' }],
      marketplace: {
        actions: {},
        skills: [],
        mcpNamespaces: ['github_search'],
      },
    });
    expect(nonMatching.decide('github_search', '*')).toBe('ask');
    expect(emittedDecision(nonMatching.rules, 'github_search', '*')).toBe(
      nonMatching.decide('github_search', '*'),
    );
  });

  test('clones rules and ceilings without mutation; v1 aliases map correctly', () => {
    const source = { action: 'bash', resource: '*', effect: 'allow' as const };
    const actions: Record<string, 'allow' | 'ask' | 'deny'> = {
      bash: 'allow',
    };
    const skills = ['simplify'];
    const policy = compilePermissionPolicy({
      baselineRules: [source],
      hostRules: [],
      marketplace: { actions, skills, mcpNamespaces: [] },
    });
    source.effect = 'deny';
    actions.bash = 'deny';
    skills.push('other');

    expect(
      policy.rules.findLast((rule) => rule.action === 'bash')?.effect,
    ).toBe('allow');
    expect(Object.isFrozen(policy.rules)).toBe(true);
    expect(Object.isFrozen(policy.rules[0])).toBe(true);
    expect(policy.decide('bash', 'command')).toBe('allow');
    expect(policy.decideSkill('other')).toBe('deny');
    expect(v1PermissionTargets('bash')).toEqual([
      { action: 'execute', resource: '*' },
      { action: 'bash', resource: '*' },
    ]);
  });
});

function emittedDecision(
  rules: readonly V2PermissionRule[],
  action: string,
  resource: string,
): V2PermissionRule['effect'] {
  return (
    rules.findLast(
      (rule) =>
        matcher(action, rule.action) && matcher(resource, rule.resource),
    )?.effect ?? 'ask'
  );
}

function matcher(value: string, pattern: string): boolean {
  const escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 's').test(value.replaceAll('\\', '/'));
}
